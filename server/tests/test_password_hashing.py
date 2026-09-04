"""Password hashing must survive its own settings changing.

The work factor is written into the stored hash so the test suite can
hash cheaply without any risk to a real ledger. That is only safe if a
password saved under one factor still verifies under another — otherwise
a shop that ever ran the tests, or upgraded, would be locked out of its
own books.
"""
import hashlib

from app import security
from app.security import hash_password, verify_password


def test_a_password_verifies_against_its_own_hash():
    assert verify_password("hunter2", hash_password("hunter2"))


def test_the_wrong_password_is_refused():
    assert not verify_password("hunter3", hash_password("hunter2"))


def test_the_work_factor_is_written_into_the_hash():
    stored = hash_password("hunter2")
    assert stored.split("$")[0] == f"scrypt{security._SCRYPT_N}"


def test_two_hashes_of_one_password_differ():
    """Each hash carries its own salt, so a stolen file can't be scanned
    for shared passwords."""
    assert hash_password("hunter2") != hash_password("hunter2")


def test_a_hash_written_at_a_different_cost_still_opens(monkeypatch):
    """The case that matters: a shop hashed its password at the full cost,
    then runs a build that hashes cheaply. It must still be able to log in."""
    monkeypatch.setattr(security, "_SCRYPT_N", 2**14)
    stored = hash_password("hunter2")
    monkeypatch.setattr(security, "_SCRYPT_N", 2**8)
    assert verify_password("hunter2", stored)
    assert not verify_password("wrong", stored)


def test_a_hash_from_before_the_cost_was_recorded_still_opens():
    """Hashes written by earlier versions have no cost in them and were
    always scrypt at 2**14."""
    salt = bytes.fromhex("00" * 16)
    dk = hashlib.scrypt(b"hunter2", salt=salt, n=2**14, r=8, p=1, dklen=32)
    assert verify_password("hunter2", f"scrypt${salt.hex()}${dk.hex()}")


def test_a_stored_hash_demanding_a_trivial_cost_is_refused():
    """A tampered file must not be able to talk the check into doing no
    work at all."""
    salt = bytes.fromhex("00" * 16)
    dk = hashlib.scrypt(b"hunter2", salt=salt, n=2, r=8, p=1, dklen=32)
    assert not verify_password("hunter2", f"scrypt2${salt.hex()}${dk.hex()}")


def test_a_stored_hash_demanding_absurd_work_is_refused():
    """Otherwise a tampered file is a way to hang the server."""
    assert not verify_password("hunter2", "scrypt1073741824$00$00")


def test_a_cost_that_is_not_a_power_of_two_is_refused():
    assert not verify_password("hunter2", "scrypt1000$00$00")


def test_rubbish_in_the_password_column_is_refused_not_crashed():
    for junk in ("", "$", "scrypt$", "not-a-hash", "scrypt$zz$zz",
                 "scryptX$00$00", "a$b$c$d"):
        assert not verify_password("hunter2", junk)


def test_an_empty_password_never_opens_a_real_hash():
    assert not verify_password("", hash_password("hunter2"))
