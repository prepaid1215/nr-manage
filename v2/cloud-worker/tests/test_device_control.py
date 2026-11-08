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
        self.assertTrue(self.db.call_args.args[2]['p_enabled'])

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


if __name__ == '__main__':
    unittest.main()
