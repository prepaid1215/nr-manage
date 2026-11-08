"""Browser integration against the real recovery routes and a test-only in-memory Auth/DB adapter.

No production account is read or changed. Run directly; needs Python Playwright + installed Edge.
"""
import logging
import sys
import threading
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_account_recovery import ADMIN_ID, USER_ID, FakeStore, create_recovery_blueprint

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
store = FakeStore()
app = Flask(__name__)
origin = "http://127.0.0.1:0"

STUB = r'''
let session = null;
export function setRememberLogin() {}
export async function signIn({username, password}) {
  const response = await fetch('/__test/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password})});
  if (!response.ok) throw Error('아이디 또는 비밀번호를 확인하세요.');
  session = await response.json(); return {session};
}
export async function signUp({username,password,name,memberNo}) {
  const response = await fetch('/__test/signup', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password,name,memberNo})});
  session = await response.json(); return {session};
}
export async function currentProfile() {
  return session ? (await (await fetch('/__test/profile?id='+session.user.id)).json()) : null;
}
const chain = new Proxy({}, {get(target,key) {
  if (key === 'then') return (resolve,reject) => Promise.resolve({data:[],error:null}).then(resolve,reject);
  return () => chain;
}});
export const supabase = {
  from: () => chain,
  rpc: async (name) => ({data: name === 'is_app_admin' ? session?.user.id === '22222222-2222-4222-8222-222222222222' : [], error:null}),
  auth: {
    getSession: async () => ({data:{session}}),
    getUser: async () => ({data:{user:session ? await (await fetch('/__test/user?id='+session.user.id)).json() : null},error:null}),
    signOut: async () => { session=null; return {error:null}; },
  }
};
'''


@app.get("/__test/profile")
def profile():
    return jsonify(store.profiles[request.args["id"]])


@app.get("/__test/user")
def user():
    return jsonify(store.users[request.args["id"]])


def session(user_id):
    return dict(access_token=user_id, user=store.users[user_id])


@app.post("/__test/login")
def login():
    data = request.json
    for user_id, row in store.profiles.items():
        if row["username"] == data["username"] and store.passwords[user_id] == data["password"]:
            return jsonify(session(user_id))
    return jsonify(error="invalid"), 403


@app.post("/__test/signup")
def signup():
    data = request.json
    store.profiles[USER_ID].update(username=data["username"], name=data["name"], member_no=data["memberNo"])
    store.passwords[USER_ID] = data["password"]
    return jsonify(session(USER_ID))


@app.get("/js/supabase.js")
def auth_stub():
    return Response(STUB, content_type="text/javascript")


@app.get("/js/account-recovery.js")
def recovery_module():
    source = (FRONTEND / "js/account-recovery.js").read_text(encoding="utf-8")
    source = source.replace('"https://nrc-sync-cloud-sg.onrender.com/account-recovery"', 'window.location.origin + "/account-recovery"')
    return Response(source, content_type="text/javascript")


@app.get("/")
def index():
    return send_from_directory(FRONTEND, "index.html")


@app.get("/<path:path>")
def static_file(path):
    return send_from_directory(FRONTEND, path)


def run():
    server = make_server("127.0.0.1", 0, app, threaded=True)
    base = f"http://127.0.0.1:{server.server_port}"
    app.register_blueprint(create_recovery_blueprint(store, "test-only-key", base))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 390, "height": 844}, service_workers="block")
            page.set_default_timeout(12000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("https://**/*", lambda route: route.abort())
            page.goto(base)
            page.locator("#loginView").wait_for(state="visible")
            page.locator("#authModeBtn").click()
            page.locator("#signupQuestion").wait_for(state="visible")
            page.locator("#signupName").fill("테스트회원")
            page.locator("#signupMemberNo").fill("12345")
            page.locator("#loginUsername").fill("member01")
            page.locator("#loginPassword").fill("Current!123")
            page.locator("#signupQuestion").select_option("secret_word")
            page.locator("#signupAnswer").fill("Secret Place")
            page.locator("#signupAnswerConfirm").fill("Secret Place")
            page.locator("#authSubmit").click()
            page.locator("#appView").wait_for(state="visible")
            assert USER_ID in store.quizzes
            assert page.locator("#signupAnswer").input_value() == ""
            assert page.locator("#loginPassword").input_value() == ""
            print("Browser passed: signup registers hashed quiz and clears secret inputs.")

            # A fresh page has a fresh test Auth session, matching a logged-out browser.
            page.goto(base)
            page.locator("#findUsername").click()
            page.locator("#recoveryName").fill("테스트회원")
            page.locator("#recoveryMemberNo").fill("12345")
            page.locator("#recoveryQuestion").select_option("secret_word")
            page.locator("#recoveryAnswer").fill("wrong answer")
            page.locator("#recoverySubmit").click()
            page.locator("#recoveryError").filter(has_text="일치하지").wait_for()
            page.locator("#recoveryAnswer").fill(" secret   place ")
            page.locator("#recoverySubmit").click()
            page.locator("#recoveryResult").filter(has_text="member01").wait_for()
            assert page.locator("#recoveryAnswer").input_value() == ""
            assert page.locator("#recoveryDialog").evaluate("e => e.getBoundingClientRect().width") <= 390
            page.locator("#recoveryClose").click()
            page.locator("#findPassword").click()
            page.locator("#recoveryUsername").fill("member01")
            page.locator("#recoveryMemberNo").fill("12345")
            page.locator("#recoveryQuestion").select_option("secret_word")
            page.locator("#recoveryAnswer").fill("secret place")
            page.locator("#recoveryPassword").fill("Recovered!123")
            page.locator("#recoveryPasswordConfirm").fill("different!123")
            page.locator("#recoverySubmit").click()
            page.locator("#recoveryError").filter(has_text="서로 일치").wait_for()
            page.locator("#recoveryPasswordConfirm").fill("Recovered!123")
            page.locator("#recoverySubmit").click()
            page.locator("#recoveryResult").filter(has_text="변경했습니다").wait_for()
            assert store.passwords[USER_ID] == "Recovered!123"
            page.locator("#recoveryClose").click()
            print("Browser passed: wrong quiz, username recovery, password confirmation and password reset.")

            # Render the actual admin module using the existing user overview shape.
            page.locator("#loginUsername").fill("admin01")
            page.locator("#loginPassword").fill("Current!123")
            page.locator("#authSubmit").click()
            page.locator("#appView").wait_for(state="visible")
            await_admin = """async () => {
              const {supabase}=await import('/js/supabase.js?v=20260829-34');
              const original = supabase.rpc;
              supabase.rpc=async(name,...args)=>name==='admin_user_overview'
                ? {data:[{user_id:'11111111-1111-4111-8111-111111111111',username:'member01',name:'테스트회원',member_no:'12345',status:'ACTIVE'}],error:null}
                : original(name,...args);
              const {adminPage}=await import('/js/admin.js?v=20261108-1');
              await adminPage(document.getElementById('content'));
            }"""
            page.evaluate(await_admin)
            page.locator("[data-admin-reset]").click()
            page.locator("#adminResetCurrentPassword").fill("wrong")
            page.locator("#adminResetSubmit").click()
            page.locator("#adminResetError").filter(has_text="일치하지").wait_for()
            page.locator("#adminResetCurrentPassword").fill("Current!123")
            page.locator("#adminResetSubmit").click()
            page.locator("#adminResetResult").wait_for(state="visible")
            temporary = page.locator("#adminTemporaryPassword").input_value()
            assert temporary == store.passwords[USER_ID]
            page.locator("#adminResetClose").click()
            assert page.locator("#adminTemporaryPassword").input_value() == ""
            print("Browser passed: admin reset button, administrator reauthentication, one-time display and clearing.")

            page.goto(base)
            page.locator("#loginUsername").fill("member01")
            page.locator("#loginPassword").fill(temporary)
            page.locator("#authSubmit").click()
            page.locator("#passwordChangeDialog").wait_for(state="visible")
            assert page.locator("#appView").is_hidden()
            page.keyboard.press("Escape")
            assert page.locator("#passwordChangeDialog").is_visible()
            page.locator("#temporaryPassword").fill(temporary)
            page.locator("#requiredNewPassword").fill("Final!12345")
            page.locator("#requiredPasswordConfirm").fill("Final!12345")
            page.locator("#passwordChangeSubmit").click()
            page.locator("#passwordChangeDialog").wait_for(state="detached")
            assert store.passwords[USER_ID] == "Final!12345"
            assert not store.users[USER_ID]["app_metadata"]["recovery_password_required"]
            assert page.locator("#loginView").is_visible()
            page.locator("#loginUsername").fill("member01")
            page.locator("#loginPassword").fill("Final!12345")
            page.locator("#authSubmit").click()
            page.locator("#appView").wait_for(state="visible")
            page.locator('#bottomNav [data-page="more"]').click()
            page.locator('#content [data-page="settings"]').click()
            page.locator('[data-settings-view="account"]').click()
            page.locator("#quizState").filter(has_text="등록되어").wait_for()
            page.locator("#quizCurrentPassword").fill("Final!12345")
            page.locator("#quizQuestion").select_option("nickname")
            page.locator("#quizAnswer").fill("새로운 비밀")
            page.locator("#quizAnswerConfirm").fill("다른 답")
            page.locator("#quizSave").click()
            page.locator("#quizSettingsError").filter(has_text="일치하지").wait_for()
            page.locator("#quizAnswerConfirm").fill("새로운 비밀")
            page.locator("#quizSave").click()
            page.locator("#quizState").filter(has_text="저장했습니다").wait_for()
            assert store.quizzes[USER_ID]["question"] == "nickname"
            assert page.locator("#quizAnswer").input_value() == ""
            assert page.locator("#quizCurrentPassword").input_value() == ""
            assert not errors, errors
            print("Browser passed: mandatory temporary-password change, fresh login, settings quiz changes; no JavaScript errors.")
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    run()
