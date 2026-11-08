"""Exercise the HTTP paths that must keep working while an update waits."""
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api
from work_guard import ActivityGate


class UpdateApiTests(unittest.TestCase):
    def setUp(self):
        self.client = api.app.test_client()
        self.gate = ActivityGate()
        self.addCleanup(patch.stopall)
        patch.object(api, 'ACTIVITY', self.gate).start()
        patch.object(api, 'SYNC_TOKEN', 'test-token').start()

    def test_health_and_status_remain_available_during_update(self):
        self.assertTrue(self.gate.pause(timeout=0))
        try:
            response = self.client.get('/health')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['release'], api.APP_RELEASE)
            self.assertEqual(self.client.get('/update-status').status_code, 200)
        finally:
            self.gate.resume()

    def test_sales_refresh_waits_for_reserved_background_task(self):
        collected = threading.Event()
        with patch.object(api, 'run_sales_now', side_effect=lambda _: collected.set()), \
                patch.object(api, 'load_json', return_value={'sales': []}):
            response = self.client.get('/api/sales?refresh=1', headers={'X-NRC-Sync-Token':'test-token'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(collected.is_set())
        self.assertEqual(self.gate.active, 0)

    def test_unauthorized_requests_do_not_hold_update_gate(self):
        self.assertEqual(self.client.get('/api/sales').status_code, 401)
        self.assertEqual(self.gate.active, 0)


if __name__ == '__main__':
    unittest.main()
