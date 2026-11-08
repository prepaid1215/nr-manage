import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import queue_worker as worker


class WorkerRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.device=dict(id='33333333-3333-4333-8333-333333333333',owner_id='owner',
                         device_name='My PC',source_account_id='nrc-test')
        self.addCleanup(patch.stopall)
        patch.object(worker,'_load_device',return_value=self.device).start()
        self.save=patch.object(worker,'_save_device').start()
        self.cloud=patch.object(worker,'_coordinator').start()

    def test_revoked_heartbeat_stops_claims_without_registering(self):
        self.cloud.return_value={'ok':True,'revoked':True}
        self.assertFalse(worker.heartbeat())
        self.assertTrue(self.device['revoked'])
        self.assertIsNone(worker.claim_job())
        self.assertEqual(self.cloud.call_count,1)
        self.assertEqual(self.cloud.call_args.args[0],'/worker/heartbeat')

    def test_remote_restore_is_observed_by_heartbeat(self):
        self.device['revoked']=True
        self.cloud.return_value={'ok':True,'revoked':False}
        self.assertTrue(worker.heartbeat())
        self.assertFalse(self.device['revoked'])
        self.assertEqual(self.cloud.call_args.args[0],'/worker/heartbeat')

    def test_claim_advertises_required_line_metric_capability(self):
        self.cloud.return_value={'ok':True,'job':None}
        worker.claim_job()
        self.assertEqual(self.cloud.call_args.args[1]['lineMetricsVersion'],2)
        self.assertEqual(self.cloud.call_args.args[1]['collectorVersion'],worker.COLLECTOR_VERSION)

    def test_health_metadata_contains_no_account_credentials(self):
        self.device['refreshToken']='must-not-leak'
        self.assertEqual(worker.local_device_status(),{'deviceId':self.device['id'],'deviceRevoked':False})


if __name__ == '__main__':
    unittest.main()
