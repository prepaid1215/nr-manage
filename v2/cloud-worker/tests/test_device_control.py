import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

root = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(root/'cloud-worker'), str(root/'sync-client')]
with patch('threading.Thread.start'):
    import cloud_service as service

OWNER = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'
DEVICE = '33333333-3333-4333-8333-333333333333'
JOB = '44444444-4444-4444-8444-444444444444'


class DeviceControlTests(unittest.TestCase):
    def setUp(self):
        self.client = service.app.test_client()
        self.addCleanup(patch.stopall)
        self.user = patch.object(service,'user_from_request',return_value={'id':OWNER}).start()
        self.admin = patch.object(service,'is_app_admin',return_value=False).start()
        self.db = patch.object(service,'admin_request').start()
        self.device = dict(id=DEVICE, owner_id=OWNER, device_name='My PC', status='ONLINE',
                           last_seen_at=datetime.now(timezone.utc).isoformat(), revoked_at=None,
                           collector_version='20261108-device-control-1')

    def test_member_only_sees_own_devices_but_global_counts(self):
        self.db.return_value = [self.device,dict(self.device,id=JOB,owner_id=OTHER,device_name='Private PC')]
        response = self.client.get('/devices')
        self.assertEqual([d['device_name'] for d in response.json['devices']],['My PC'])
        self.assertEqual(response.json['summary'],dict(total=2,online=2))
        self.assertNotIn('Private PC',response.text)

    def test_admin_sees_all_and_revoked_is_never_online(self):
        self.admin.return_value = True
        self.db.return_value = [self.device,dict(self.device,id=JOB,owner_id=OTHER,revoked_at='now')]
        data = self.client.get('/devices').json
        self.assertEqual(len(data['devices']),2)
        self.assertEqual(data['summary'],dict(total=1,online=1))

    def test_hidden_devices_are_not_listed(self):
        self.db.return_value = [self.device,dict(self.device,id=JOB,device_name='Old PC',hidden_at='now')]
        data = self.client.get('/devices').json
        self.assertEqual([d['device_name'] for d in data['devices']],['My PC'])

    def test_list_works_before_hidden_column_exists(self):
        self.db.side_effect = [RuntimeError('column hidden_at does not exist'),[self.device]]
        response = self.client.get('/devices')
        self.assertEqual(response.status_code,200)
        self.assertEqual(len(response.json['devices']),1)

    def test_delete_revoked_offline_pc_only_hides_row(self):
        self.device.update(revoked_at='now',status='OFFLINE')
        self.db.return_value = [self.device]
        response = self.client.delete(f'/devices/{DEVICE}')
        self.assertEqual(response.status_code,200)
        calls = [c.args for c in self.db.call_args_list]
        self.assertFalse(any(c[0].startswith('rpc/') for c in calls))
        self.assertFalse(any(c[1:2] == ('DELETE',) for c in calls))  # 행은 물리 삭제하지 않는다
        patch_call = [c for c in calls if len(c) > 1 and c[1] == 'PATCH'][-1]
        self.assertIn('hidden_at',patch_call[2])

    def test_delete_offline_active_pc_revokes_then_hides(self):
        self.device.update(status='OFFLINE',last_seen_at='2026-01-01T00:00:00+00:00')
        self.db.return_value = [self.device]
        self.assertEqual(self.client.delete(f'/devices/{DEVICE}').status_code,200)
        calls = [c.args for c in self.db.call_args_list]
        self.assertIn(('rpc/set_pc_registration','POST',dict(p_actor=OWNER,p_device=DEVICE,p_enabled=False)),calls)
        self.assertTrue(any(len(c) > 2 and isinstance(c[2],dict) and 'hidden_at' in c[2] for c in calls))

    def test_online_pc_cannot_be_deleted(self):
        self.db.return_value = [self.device]
        response = self.client.delete(f'/devices/{DEVICE}')
        self.assertEqual(response.status_code,409)
        self.assertEqual(self.db.call_count,1)

    def test_other_member_cannot_delete(self):
        self.device.update(status='OFFLINE',owner_id=OTHER)
        self.db.return_value = [self.device]
        self.assertEqual(self.client.delete(f'/devices/{DEVICE}').status_code,403)
        self.assertEqual(self.db.call_count,1)

    def test_restore_clears_hidden_flag(self):
        self.db.return_value = [self.device]
        self.assertEqual(self.client.post(f'/devices/{DEVICE}/registration').status_code,200)
        calls = [c.args for c in self.db.call_args_list]
        self.assertTrue(any(len(c) > 2 and c[2] == {'hidden_at':None} for c in calls))

    def test_owner_can_revoke(self):
        self.db.return_value = [self.device]
        response = self.client.delete(f'/devices/{DEVICE}/registration')
        self.assertEqual(response.status_code,200)
        self.db.assert_called_with('rpc/set_pc_registration','POST',dict(p_actor=OWNER,p_device=DEVICE,p_enabled=False))

    def test_other_member_cannot_revoke_or_restore(self):
        self.db.return_value = [dict(self.device,owner_id=OTHER)]
        for method in ('DELETE','POST'):
            self.db.reset_mock()
            response = self.client.open(f'/devices/{DEVICE}/registration',method=method)
            self.assertEqual(response.status_code,403)
            self.assertEqual(self.db.call_count,1)

    def test_admin_can_revoke_other_owners_pc(self):
        self.admin.return_value = True
        self.db.return_value = [dict(self.device,owner_id=OTHER)]
        self.assertEqual(self.client.delete(f'/devices/{DEVICE}/registration').status_code,200)

    def test_restore_is_an_explicit_post(self):
        self.db.return_value = [dict(self.device,revoked_at='now')]
        self.assertEqual(self.client.post(f'/devices/{DEVICE}/registration').status_code,200)
        rpc = [c.args for c in self.db.call_args_list if c.args[0] == 'rpc/set_pc_registration']
        self.assertEqual(len(rpc),1)
        self.assertTrue(rpc[0][2]['p_enabled'])

    def test_heartbeat_never_restores_revoked_pc(self):
        self.db.return_value = [dict(self.device,revoked_at='now')]
        response = self.client.post('/worker/heartbeat',json={'deviceId':DEVICE})
        self.assertTrue(response.json['revoked'])
        self.assertEqual(self.db.call_count,1)

    def test_old_collector_cannot_claim_or_receive_credentials(self):
        self.db.return_value = [self.device]
        with patch.object(service,'load_credentials') as reveal:
            response = self.client.post('/worker/claim',json={'deviceId':DEVICE})
        self.assertTrue(response.json['updateRequired'])
        self.assertIsNone(response.json['job'])
        reveal.assert_not_called()
        self.assertEqual(self.db.call_count,1)

    def test_revoked_pc_cannot_claim(self):
        self.db.return_value = []
        response = self.client.post('/worker/claim',json={'deviceId':DEVICE,'lineMetricsVersion':2,'collectorVersion':'new'})
        self.assertEqual(response.status_code,401)
        self.assertEqual(self.db.call_count,1)

    def claim_with_tracked(self, tracked_result):
        job = dict(id=JOB, owner_id=OWNER, source_account_id='qndnjsqlsim')
        self.db.side_effect = [[self.device],[job],{'ok':True},tracked_result]
        with patch.object(service,'load_credentials',return_value={'loginId':'qndnjsqlsim','password':'pw'}):
            return self.client.post('/worker/claim',json={'deviceId':DEVICE,'lineMetricsVersion':2,'collectorVersion':'new'})

    def test_claim_hands_the_registered_members_to_the_pc(self):
        response = self.claim_with_tracked([
            {'user_id':'2893496','user_name':'주영돈','rank_cd':'25','rank_name':'골드'},
            {'user_id':'abc','user_name':'bad'},
        ])
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json['job']['trackedMembers'],
                         [{'userId':'2893496','userName':'주영돈','rankCd':'25','rankName':'골드'}])
        query = self.db.call_args_list[-1].args[0]
        self.assertIn('nrc_tracked_members?owner_id=eq.'+OWNER,query)
        self.assertIn('source_account_id=eq.qndnjsqlsim',query)

    def test_claim_still_works_when_the_registered_members_table_is_missing(self):
        response = self.claim_with_tracked(RuntimeError('relation nrc_tracked_members does not exist'))
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json['job']['trackedMembers'],[])
        self.assertEqual(response.json['job']['sourceAccountId'],'qndnjsqlsim')

    def test_completion_uses_atomic_rpc(self):
        self.db.side_effect = [[self.device],{'ok':True}]
        worker = service.pc_worker_id(OWNER,DEVICE)
        response = self.client.post('/worker/complete',json={
            'deviceId':DEVICE,'jobId':JOB,'leaseToken':service.lease_token(JOB,worker),
            'payload':{'sourceAccountId':'test'},
        })
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.db.call_args.args[0],'rpc/complete_pc_sync_job')

    def test_completion_from_revoked_pc_never_stores_results(self):
        self.db.return_value = []
        worker = service.pc_worker_id(OWNER,DEVICE)
        response = self.client.post('/worker/complete',json={
            'deviceId':DEVICE,'jobId':JOB,'leaseToken':service.lease_token(JOB,worker),'payload':{},
        })
        self.assertEqual(response.status_code,401)
        self.assertEqual(self.db.call_count,1)


class DailyCaptureScheduleTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        self.db = patch.object(service,'admin_request').start()
        service._last_metrics_day = None
        service._last_metrics_attempt = 0.0
        self.clock = patch.object(service,'datetime').start()

    def at(self,hour,minute,day=25):
        kst = timezone(__import__('datetime').timedelta(hours=9))
        self.clock.now.return_value = datetime(2026,11,day,hour,minute,tzinfo=kst)

    def test_waits_until_the_early_morning_collection_window_has_ended(self):
        self.at(6,29)
        service.capture_daily_metrics_once_per_day()
        self.db.assert_not_called()

    def test_records_the_last_three_days_after_0630(self):
        self.at(6,30)
        service.capture_daily_metrics_once_per_day()
        self.assertEqual([c.args[2]['p_date'] for c in self.db.call_args_list],['2026-11-22','2026-11-23','2026-11-24'])
        self.assertTrue(all(c.args[0] == 'rpc/capture_daily_nrc_metrics' for c in self.db.call_args_list))

    def test_runs_only_once_a_day(self):
        self.at(7,0)
        service.capture_daily_metrics_once_per_day()
        service.capture_daily_metrics_once_per_day()
        self.assertEqual(self.db.call_count,3)

    def test_next_day_records_again(self):
        self.at(7,0)
        service.capture_daily_metrics_once_per_day()
        service._last_metrics_attempt = 0.0
        self.at(7,0,day=26)
        service.capture_daily_metrics_once_per_day()
        self.assertEqual(self.db.call_count,6)

    def test_failure_tries_every_day_raises_and_waits_before_retrying(self):
        self.at(8,0)
        self.db.side_effect = [RuntimeError('not ready'),None,None]
        with self.assertRaises(RuntimeError):
            service.capture_daily_metrics_once_per_day()
        self.assertEqual(self.db.call_count,3,'한 날짜가 실패해도 나머지는 시도한다')
        self.assertIsNone(service._last_metrics_day,'실패하면 오늘 한 것으로 치지 않는다')
        self.db.reset_mock(side_effect=True)
        service.capture_daily_metrics_once_per_day()
        self.db.assert_not_called()


if __name__ == '__main__':
    unittest.main()
