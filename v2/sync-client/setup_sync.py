import secrets
from pathlib import Path

env_path = Path(__file__).with_name('.env')
if env_path.exists():
    print('이미 .env가 있습니다. 기존 연결 코드를 유지합니다.')
else:
    token = secrets.token_hex(16)
    env_path.write_text(f'NRC_SYNC_TOKEN={token}\n', encoding='utf-8')
    print('NRC Sync 연결 코드:')
    print(token)
    print('웹앱 설정 > 내 컴퓨터 연결 코드에 입력하세요.')
