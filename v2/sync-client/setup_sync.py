import secrets
from pathlib import Path

env_path = Path(__file__).with_name('.env')
if env_path.exists():
    print('NRC Sync 기본 설정이 이미 있습니다.')
else:
    token = secrets.token_hex(16)
    env_path.write_text(f'NRC_SYNC_TOKEN={token}\n', encoding='utf-8')
    print('NRC Sync 기본 설정을 만들었습니다.')
print('이제 python api.py를 실행한 뒤 http://127.0.0.1:5050/setup 에서 이 PC를 등록하세요.')
