"""Break password hashing on purpose and check the tests notice.

This is the one piece of code where a silent failure means either a shop
locked out of its own books, or a door left open. The work factor now
travels inside the stored hash, so the mutations below attack exactly
that: reading it wrong, ignoring it, or letting a tampered file choose
one that costs nothing.

    python setup\\mutate_password.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

SRC = "server/app/security.py"

MUTATIONS = [
    ("verify at a fixed cost, locking out anyone hashed at another",
     "        dk = _scrypt(password, bytes.fromhex(salt_hex), n)",
     "        dk = _scrypt(password, bytes.fromhex(salt_hex), _SCRYPT_N)"),

    ("misread hashes written before the cost was recorded",
     'n = int(algo[len("scrypt"):]) if algo != "scrypt" else 2**14',
     'n = int(algo[len("scrypt"):]) if algo != "scrypt" else 2**8'),

    ("let a tampered hash pick a cost of nothing",
     "        if n < 2**8:",
     "        if False:"),

    ("forget to record the cost, so nothing can be read back",
     'return f"scrypt{_SCRYPT_N}${salt.hex()}${_scrypt(password, salt, _SCRYPT_N)}"',
     'return f"scrypt${salt.hex()}${_scrypt(password, salt, _SCRYPT_N)}"'),

    ("reuse one salt, so a stolen file shows who shares a password",
     "    salt = os.urandom(16)",
     "    salt = b'\\0' * 16"),

    ("compare loosely, so any password opens any account",
     "        return hmac.compare_digest(dk, dk_hex)",
     "        return True"),

    ("let rubbish in the password column crash the login instead of failing",
     "    except (ValueError, TypeError):\n        return False",
     "    except TypeError:\n        return False"),
]


if __name__ == "__main__":
    raise SystemExit(check(["tests/test_password_hashing.py",
                            "tests/test_permissions.py"],
                           [(SRC, *m) for m in MUTATIONS]))
