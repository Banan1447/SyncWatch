import hmac, hashlib, struct, time, base64, json, random, string, sys, subprocess, urllib3
import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE = "https://localhost:8443/api/v1"

def totp_code(secret, period=30, digits=6):
    key = base64.b32decode(secret.upper() + "=" * ((8 - len(secret) % 8) % 8))
    counter = int(time.time()) // period
    msg = struct.pack(">Q", counter)
    h = hmac.new(key, msg, hashlib.sha1).digest()
    o = h[-1] & 0x0F
    code = (struct.unpack(">I", h[o:o+4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)

def rand_suffix():
    return ''.join(random.choices(string.ascii_lowercase, k=6))

def post(path, json_body=None, token=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    r = requests.post(BASE + path, json=json_body, headers=h, verify=False, timeout=15)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, {"raw": r.text[:200]}

def get(path, token=None):
    h = {}
    if token:
        h["Authorization"] = "Bearer " + token
    r = requests.get(BASE + path, headers=h, verify=False, timeout=15)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, {"raw": r.text[:200]}

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS" if cond else "FAIL"), "-", name, ("| " + str(detail) if detail else ""))

def db(sql):
    r = subprocess.run(["docker", "exec", "watchsync-postgres", "psql", "-tA", "-U", "watchsync", "-d", "watchsync",
                        "-c", sql], capture_output=True, text=True)
    return r.stdout.strip()

pw = "Test2fa!%" + rand_suffix()
u1 = "__2fa_a_" + rand_suffix()
u2 = "__2fa_b_" + rand_suffix()

try:
    # 1. register (rate-limited to 3/min — space them out)
    sc, d = post("/auth/register", {"username": u1, "password": pw})
    check("register u1", sc == 201)
    time.sleep(1.5)
    sc, d = post("/auth/register", {"username": u2, "password": pw})
    check("register u2", sc == 201)

    # 2. login u1
    time.sleep(1.5)
    sc, d = post("/auth/login", {"username": u1, "password": pw})
    tok1 = d.get("access_token")
    check("login u1", sc == 200 and tok1, d.get("error") or d.get("message"))

    # 3. /me returns totp_enabled=false
    sc, me = get("/auth/me", tok1)
    check("me has totp_enabled field (false)", sc == 200 and "totp_enabled" in me and me["totp_enabled"] == False)

    # 4. setup + enable
    sc, d = post("/auth/totp/setup", {}, tok1)
    secret = d.get("secret")
    check("totp setup returns secret+qr", sc == 200 and secret and d.get("qr_url"))
    sc, d = post("/auth/totp/enable", {"code": totp_code(secret)}, tok1)
    check("totp enable", sc == 200 and d.get("status") == "totp_enabled", d)

    # 5. /me shows totp_enabled=true (THE BUG FIX)
    sc, me = get("/auth/me", tok1)
    check("me shows totp_enabled=true after enable (bug fix)", sc == 200 and me.get("totp_enabled") == True)

    # 6. disable
    sc, d = post("/auth/totp/disable", {"code": totp_code(secret)}, tok1)
    check("totp disable", sc == 200 and d.get("status") == "totp_disabled", d)
    sc, me = get("/auth/me", tok1)
    check("me shows totp_enabled=false after disable", sc == 200 and me.get("totp_enabled") == False)

    # 7. promote u1 to admin via DB, re-login (no 2FA now) for fresh admin token
    db(f"UPDATE users SET subscription_tier='admin' WHERE username='{u1}';")
    time.sleep(1.5)
    sc, d = post("/auth/login", {"username": u1, "password": pw})
    tok_admin = d.get("access_token")
    check("re-login u1 as admin", sc == 200 and tok_admin, d.get("error") or d.get("message"))

    # 8. admin list users shows 2FA flags
    sc, users = get("/auth/users", tok_admin)
    check("admin list users 200", sc == 200 and isinstance(users, list), f"{sc}")
    u1_row = next((x for x in users if x["username"] == u1), {}) if isinstance(users, list) else {}
    u2_row = next((x for x in users if x["username"] == u2), {}) if isinstance(users, list) else {}
    check("list users has totp_enabled/totp_required fields", "totp_enabled" in u1_row and "totp_required" in u1_row)

    # 9. non-admin guard: tok1 (issued before promotion, is_admin=false) cannot list users
    sc, _ = get("/auth/users", tok1)
    check("non-admin cannot list users (403)", sc == 403, sc)

    # 10. admin require 2FA on u2
    sc, d = post(f"/auth/users/{u2_row['id']}/totp/require", {}, tok_admin)
    check("admin require 2FA u2", sc == 200 and d.get("totp_required") == True, d)

    # 11. u2 login -> totp_setup_required
    time.sleep(1.5)
    sc, d = post("/auth/login", {"username": u2, "password": pw})
    check("u2 login forces setup", sc == 200 and d.get("totp_setup_required") == True and d.get("temp_token"))
    temp_tok = d.get("temp_token")

    # 12. forced setup + enable (no JWT — relies on temp_token through public route)
    sc, d = post("/auth/totp/setup", {"temp_token": temp_tok})
    secret2 = d.get("secret")
    check("forced setup returns secret (public route)", sc == 200 and secret2, d)
    sc, d = post("/auth/totp/enable", {"temp_token": temp_tok, "code": totp_code(secret2)})
    check("forced enable returns full tokens", sc == 200 and d.get("access_token") and d.get("refresh_token"))
    tok2 = d.get("access_token")

    # 13. u2 /me enabled, required cleared
    sc, me = get("/auth/me", tok2)
    check("u2 me enabled=true required=false", sc == 200 and me.get("totp_enabled") == True and me.get("totp_required") == False)

    # 14. regression: u2 re-login now requires normal 2FA step
    time.sleep(1.5)
    sc, d = post("/auth/login", {"username": u2, "password": pw})
    check("u2 re-login requires TOTP (normal 2FA login)", sc == 200 and d.get("totp_required") == True and d.get("temp_token"))
    login_temp = d.get("temp_token")
    sc, d = post("/auth/totp/verify", {"temp_token": login_temp, "code": totp_code(secret2)})
    check("totp verify completes login", sc == 200 and d.get("access_token"))

    # 15. admin list shows u2 totp_enabled=true
    sc, users = get("/auth/users", tok_admin)
    u2_row2 = next((x for x in users if x["username"] == u2), {}) if isinstance(users, list) else {}
    check("admin list shows u2 totp_enabled=true", u2_row2.get("totp_enabled") == True and u2_row2.get("totp_required") == False)

    # 16. admin reset 2FA on u2
    sc, d = post(f"/auth/users/{u2_row['id']}/totp/reset", {}, tok_admin)
    check("admin reset 2FA u2", sc == 200 and d.get("totp_enabled") == False and d.get("totp_required") == False, d)

    # 17. DB confirms secret + requirement removed
    secret_db = db(f"SELECT preferences->>'totp_secret' FROM users WHERE username='{u2}';")
    req_db = db(f"SELECT (preferences->>'totp_required')::boolean FROM users WHERE username='{u2}';")
    check("DB: u2 totp_secret removed after reset", secret_db == "" or secret_db == "None")
    check("DB: u2 totp_required cleared after reset", req_db in ("", "f", "false", "None"))

finally:
    db(f"DELETE FROM users WHERE username IN ('{u1}','{u2}');")
    print("--- CLEANUP DONE ---")

print("\n=== SUMMARY ===")
fails = [r for r in results if not r[1]]
print(f"{len(results)-len(fails)}/{len(results)} passed")
if fails:
    for n, _, det in fails:
        print("  FAILED:", n, det)
    sys.exit(1)
