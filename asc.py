"""App Store Connect reads and the one write this cut needs.

ES256 JWT built from the private key on disk; no PyJWT. Read-only by default --
`assign` is the only mutating verb and it is never called implicitly.
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

KEYS = os.path.expanduser("~/.private_keys")
KEY_ID = open(f"{KEYS}/asc_key_id").read().strip()
ISSUER = open(f"{KEYS}/asc_issuer_id").read().strip()
APP_ID = "6802417672"
GROUP_ID = "50ac3e8f-19d6-44bd-beb4-8955e262fa52"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def token() -> str:
    key = serialization.load_pem_private_key(
        open(f"{KEYS}/AuthKey_{KEY_ID}.p8", "rb").read(), password=None
    )
    header = {"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}
    now = int(time.time())
    payload = {"iss": ISSUER, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}
    signing_input = f"{b64url(json.dumps(header).encode())}.{b64url(json.dumps(payload).encode())}"
    der = key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{signing_input}.{b64url(raw)}"


def call(method: str, path: str, body: dict | None = None, tries: int = 3):
    """A fresh token can 401 transiently; the skill says retry before debugging."""
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(
            f"https://api.appstoreconnect.apple.com{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {token()}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req) as response:
                text = response.read().decode()
                return response.status, (json.loads(text) if text else {})
        except urllib.error.HTTPError as err:
            last = (err.code, err.read().decode())
            if err.code == 401 and attempt + 1 < tries:
                time.sleep(2)
                continue
            return last
    return last


def builds(limit: int = 8):
    status, data = call(
        "GET",
        f"/v1/builds?filter[app]={APP_ID}&sort=-uploadedDate&limit={limit}"
        "&fields[builds]=version,processingState,uploadedDate,usesNonExemptEncryption,expired",
    )
    if status != 200:
        print(f"HTTP {status}: {data}")
        return []
    rows = []
    for item in data.get("data", []):
        a = item["attributes"]
        rows.append(
            {
                "id": item["id"],
                "version": a.get("version"),
                "state": a.get("processingState"),
                "encryption": a.get("usesNonExemptEncryption"),
                "expired": a.get("expired"),
                "uploaded": a.get("uploadedDate"),
            }
        )
    return rows


def main() -> None:
    verb = sys.argv[1] if len(sys.argv) > 1 else "builds"

    if verb == "builds":
        for row in builds():
            print(
                f"{row['version']:>4}  {row['state']:<12} enc={row['encryption']}  "
                f"expired={row['expired']}  {row['uploaded']}  {row['id']}"
            )

    elif verb == "wait":
        want = sys.argv[2]
        deadline = time.time() + 40 * 60
        while time.time() < deadline:
            for row in builds():
                if row["version"] != want:
                    continue
                print(f"{row['version']}  {row['state']}  enc={row['encryption']}  {row['id']}", flush=True)
                if row["state"] in {"VALID", "INVALID", "FAILED"}:
                    return
            time.sleep(30)
        print("timed out waiting")

    elif verb == "assign":
        build_id = sys.argv[2]
        status, data = call(
            "POST",
            f"/v1/betaGroups/{GROUP_ID}/relationships/builds",
            {"data": [{"type": "builds", "id": build_id}]},
        )
        print(f"assign -> HTTP {status} {data if data else ''}")

    elif verb == "readback":
        # Independent: ask the GROUP what builds it holds, not the build what
        # groups it is in. A write that half-landed reads differently here.
        status, data = call(
            "GET",
            f"/v1/betaGroups/{GROUP_ID}/builds"
            "?limit=10&fields[builds]=version,processingState,uploadedDate",
        )
        if status != 200 or not isinstance(data, dict):
            print(f"HTTP {status}: {data}")
            return
        print(f"HTTP {status}")
        rows = sorted(
            data.get("data", []),
            key=lambda item: item["attributes"].get("uploadedDate") or "",
            reverse=True,
        )
        for item in rows:
            a = item["attributes"]
            print(f"  group holds build {a.get('version')}  {a.get('processingState')}  {item['id']}")

    elif verb == "group":
        status, data = call(
            "GET",
            f"/v1/betaGroups/{GROUP_ID}?fields[betaGroups]=name,isInternalGroup,publicLinkEnabled",
        )
        print(f"HTTP {status} {json.dumps((data or {}).get('data', {}).get('attributes', {}), indent=2)}")

    elif verb == "testers":
        status, data = call(
            "GET",
            f"/v1/betaGroups/{GROUP_ID}/betaTesters?limit=20&fields[betaTesters]=email,firstName,lastName,state",
        )
        print(f"HTTP {status}")
        for item in (data or {}).get("data", []):
            a = item["attributes"]
            print(f"  {a.get('email')}  {a.get('firstName')} {a.get('lastName')}  {a.get('state')}")

    elif verb == "betastate":
        # The state TestFlight itself reports for the build, asked of the
        # build's own beta detail rather than inferred from processingState.
        build_id = sys.argv[2]
        status, data = call(
            "GET",
            f"/v1/builds/{build_id}/buildBetaDetail"
            "?fields[buildBetaDetails]=internalBuildState,externalBuildState",
        )
        print(f"HTTP {status} {json.dumps((data or {}).get('data', {}).get('attributes', {}), indent=2)}")

    elif verb == "buildinfo":
        build_id = sys.argv[2]
        status, data = call(
            "GET",
            f"/v1/builds/{build_id}?fields[builds]=version,processingState,usesNonExemptEncryption,uploadedDate",
        )
        print(f"HTTP {status} {json.dumps((data or {}).get('data', {}).get('attributes', {}), indent=2)}")

    else:
        print(f"unknown verb {verb}")


main()
