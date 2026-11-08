// Run with a temporary @electric-sql/pglite installation; never connects to a hosted database.
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { PGlite } = createRequire(join(process.argv[2], 'package.json'))('@electric-sql/pglite');

(async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.profiles(id uuid primary key, username text, member_no text, name text, status text);
      create table public.audit_logs(id bigint generated always as identity primary key,
        actor_id uuid, action text, target_type text, target_id text, result text, detail jsonb);
    `);
    const sql = readFileSync(join(__dirname, '../migrations/20261108064954_account_recovery_quiz.sql'), 'utf8');
    assert.equal(sql, readFileSync(join(__dirname, '../RUN_046_ACCOUNT_RECOVERY_QUIZ.sql'), 'utf8'));
    await db.exec(sql);
    for (const table of ['account_recovery_quizzes', 'account_recovery_attempts']) {
      const result = await db.query(`select relrowsecurity from pg_class where oid = $1::regclass`, ['public.' + table]);
      assert.equal(result.rows[0].relrowsecurity, true);
      for (const role of ['anon', 'authenticated']) {
        const grants = await db.query('select has_table_privilege($1, $2, $3) as allowed', [role, 'public.' + table, 'SELECT,INSERT,UPDATE,DELETE']);
        assert.equal(grants.rows[0].allowed, false);
      }
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from public.account_recovery_quizzes'), /permission denied/);
      await assert.rejects(db.query('select public.consume_account_recovery_attempt($1, $2)', ['a'.repeat(64), 'b'.repeat(64)]), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    await db.query('select id, username, member_no, name, status from public.profiles limit 1');
    await db.query("insert into public.audit_logs(actor_id, action, target_type, target_id, result, detail) values (null, 'admin_password_reset', 'account', 'test', 'REQUESTED', '{}')");
    const consume = async (account, client) => (await db.query(
      'select public.consume_account_recovery_attempt($1, $2) as allowed', [account, client])).rows[0].allowed;
    for (let i = 0; i < 5; i++) assert.equal(await consume('a'.repeat(64), 'b'.repeat(64)), true);
    assert.equal(await consume('a'.repeat(64), 'b'.repeat(64)), false);
    assert.equal(await consume('invalid', 'b'.repeat(64)), false);
    assert.equal(await consume(null, 'b'.repeat(64)), false);
    await db.exec("update public.account_recovery_attempts set expires_at = now() - interval '1 second'");
    assert.equal(await consume('a'.repeat(64), 'b'.repeat(64)), true);
    // A client cannot avoid its limit by switching among different member numbers.
    for (let i = 0; i < 30; i++) assert.equal(await consume(i.toString(16).padStart(64, '0'), 'c'.repeat(64)), true);
    assert.equal(await consume('d'.repeat(64), 'c'.repeat(64)), false);
    await db.exec('reset role');
    console.log('Recovery SQL passed: RLS, revoked client grants, service-only RPC, 5/member, 30/client, expiry, invalid keys.');
  } finally {
    await db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
