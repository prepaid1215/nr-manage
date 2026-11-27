import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

root = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(root/'cloud-worker'), str(root/'sync-client')]
with patch('threading.Thread.start'):
    import cloud_service as service


def reply(status, body=None):
    return Mock(status_code=status, json=Mock(return_value=body or {'id': 'u'}))


class AuthStatusTests(unittest.TestCase):
    def setUp(self):
        self.client = service.app.test_client()
        self.addCleanup(patch.stopall)
        patch.object(service.time, 'sleep').start()
        self.headers = {'Authorization': 'Bearer token'}

    def call(self, *replies):
        with patch.object(service.requests, 'get', side_effect=list(replies)) as get:
            response = self.client.post('/worker/heartbeat', json={}, headers=self.headers)
        return response, get

    def test_expired_session_stays_401(self):
        response, get = self.call(reply(401))
        self.assertEqual(response.status_code, 401)
        self.assertIn('만료', response.json['message'])
        self.assertEqual(get.call_count, 1, '인증 거부는 다시 묻지 않는다')

    def test_auth_server_outage_is_503_not_expired(self):
        response, get = self.call(reply(502), reply(503))
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('만료', response.json['message'])
        self.assertEqual(get.call_count, 2)

    def test_connection_error_is_503(self):
        response, _ = self.call(requests.ConnectionError('down'), requests.Timeout('slow'))
        self.assertEqual(response.status_code, 503)

    def test_one_transient_failure_is_absorbed(self):
        with patch.object(service.requests, 'get', side_effect=[reply(502), reply(200, {'id': 'u'})]):
            with service.app.test_request_context(headers=self.headers):
                self.assertEqual(service.user_from_request()['id'], 'u')

    def test_missing_header_is_still_401(self):
        response = self.client.post('/worker/heartbeat', json={})
        self.assertEqual(response.status_code, 401)


if __name__ == '__main__':
    unittest.main()
