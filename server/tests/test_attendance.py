"""Attendance must survive the round trip: what you save is what you get back.

There were no tests over this router at all, which is how the shift choice
came to be dropped in two different places without anyone noticing.
"""
import pytest

TODAY = "2026-05-12"          # a Tuesday, safely inside the edit window


@pytest.fixture()
def shifts(client, outlet_id):
    made = []
    for name, start, end in (("Shift 1", "08:00", "16:00"),
                             ("Shift 2", "16:00", "23:00")):
        r = client.post("/api/staff/shifts", json={
            "name": name, "start": start, "end": end, "outlet_id": outlet_id})
        assert r.status_code == 201, r.text
        made.append(r.json())
    return made


@pytest.fixture()
def emp(client, outlet_id, shifts):
    r = client.post("/api/staff/employees", json={
        "name": "Test Cook", "outlet_id": outlet_id,
        "default_shift_id": shifts[0]["id"],
        "monthly_salary_rupees": 26000, "join_date": "2026-01-01"})
    assert r.status_code == 201, r.text
    return r.json()


def stepup(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})


def grid_cell(client, outlet_id, emp_id, day=TODAY):
    r = client.get(f"/api/attendance/grid?outlet_id={outlet_id}&start={day}&end={day}")
    assert r.status_code == 200, r.text
    for employee in r.json()["employees"]:
        if employee["id"] == emp_id:
            return employee["cells"][0]
    raise AssertionError(f"employee {emp_id} not in grid")


def bulk(client, outlet_id, entries, day=TODAY):
    return client.post("/api/attendance/bulk", json={
        "outlet_id": outlet_id, "date": day, "entries": entries})


# --- the round trip ---------------------------------------------------------

def test_marking_present_is_saved_and_read_back(client, outlet_id, emp, shifts):
    stepup(client)
    r = bulk(client, outlet_id, [{
        "employee_id": emp["id"], "status": "P",
        "in_time": "08:05", "out_time": "16:10",
        "shift_id": shifts[0]["id"], "note": "on time"}])
    assert r.status_code == 200, r.text
    assert r.json()["saved"] == 1

    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row is not None, "nothing was saved"
    assert row["status"] == "P"
    assert row["in_min"] == 8 * 60 + 5
    assert row["out_min"] == 16 * 60 + 10
    assert row["note"] == "on time"


def test_the_chosen_shift_survives_the_round_trip(client, outlet_id, emp, shifts):
    """Put someone on Shift 2 for one day; the grid must say Shift 2.

    Their roster says Shift 1, so if the saved choice is not read back the
    screen silently reverts to Shift 1 and the edit looks lost.
    """
    stepup(client)
    evening = shifts[1]
    r = bulk(client, outlet_id, [{
        "employee_id": emp["id"], "status": "P",
        "in_time": "16:00", "out_time": "23:00",
        "shift_id": evening["id"]}])
    assert r.status_code == 200, r.text

    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["shift_id"] == evening["id"], \
        f"grid lost the chosen shift: {row}"


def test_mark_endpoint_also_honours_the_chosen_shift(client, outlet_id, emp, shifts):
    """/mark accepts shift_id, so it must not quietly ignore it."""
    stepup(client)
    evening = shifts[1]
    r = client.post("/api/attendance/mark", json={
        "employee_id": emp["id"], "date": TODAY, "status": "P",
        "in_time": "16:00", "out_time": "23:00", "shift_id": evening["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["shift"]["id"] == evening["id"], \
        f"/mark dropped shift_id: {r.json()}"

    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["shift_id"] == evening["id"]


def test_editing_an_existing_day_overwrites_it(client, outlet_id, emp, shifts):
    """The second save must replace the first, not be ignored or duplicated."""
    stepup(client)
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P",
                              "in_time": "08:00", "out_time": "16:00",
                              "shift_id": shifts[0]["id"]}])
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "A"}])

    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["status"] == "A", "the edit did not stick"

    summary = client.get(
        f"/api/attendance/month-summary?employee_id={emp['id']}"
        "&year=2026&month=5").json()
    assert summary["absents"] == 1, summary
    assert summary["presents"] == 0, "the old Present survived as a duplicate row"


def test_note_and_double_duty_survive_the_round_trip(client, outlet_id, emp, shifts):
    stepup(client)
    bulk(client, outlet_id, [{
        "employee_id": emp["id"], "status": "P", "double_duty": True,
        "in_time": "08:00", "out_time": "23:00",
        "shift_id": shifts[0]["id"], "note": "covered both shifts"}])
    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["double_duty"] is True
    assert row["note"] == "covered both shifts"


def test_absent_clears_times_rather_than_keeping_stale_ones(client, outlet_id,
                                                            emp, shifts):
    stepup(client)
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P",
                              "in_time": "08:00", "out_time": "16:00",
                              "shift_id": shifts[0]["id"]}])
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "A"}])
    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["in_min"] is None and row["out_min"] is None, row
    assert row["double_duty"] is False


def test_a_bad_status_is_refused_and_changes_nothing(client, outlet_id, emp):
    stepup(client)
    r = bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "X"}])
    assert r.status_code == 422, r.text
    assert grid_cell(client, outlet_id, emp["id"])["row"] is None


def test_one_bad_entry_does_not_save_the_good_ones_beside_it(client, outlet_id,
                                                             emp, shifts):
    """A rejected batch must not half-apply."""
    stepup(client)
    r = bulk(client, outlet_id, [
        {"employee_id": emp["id"], "status": "P", "shift_id": shifts[0]["id"]},
        {"employee_id": emp["id"], "status": "NOPE"},
    ])
    assert r.status_code == 422, r.text
    assert grid_cell(client, outlet_id, emp["id"])["row"] is None, \
        "a failed batch left a partial row behind"


def test_late_is_derived_from_the_shift_actually_worked(client, outlet_id,
                                                        emp, shifts):
    """Arriving 16:40 is late for Shift 2, but would be hours late for Shift 1."""
    stepup(client)
    bulk(client, outlet_id, [{
        "employee_id": emp["id"], "status": "P",
        "in_time": "16:40", "out_time": "23:00",
        "shift_id": shifts[1]["id"]}])
    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert 0 < row["late_min"] <= 60, \
        f"late computed against the wrong shift: {row}"


def test_an_unknown_employee_is_reported_not_quietly_dropped(client, outlet_id, emp):
    """The screen throws away its unsaved edits the moment a save succeeds, so
    a save that silently marks nobody destroys the user's work."""
    stepup(client)
    r = bulk(client, outlet_id, [{"employee_id": 999999, "status": "P"}])
    assert r.status_code == 404, r.text

    # ...and a valid entry in the same batch must not have been written either
    r = bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P"},
                                 {"employee_id": 999999, "status": "P"}])
    assert r.status_code == 404, r.text
    assert grid_cell(client, outlet_id, emp["id"])["row"] is None


def test_the_grid_shows_which_shift_button_is_lit(client, outlet_id, emp, shifts):
    """The S1/S2 highlight in the grid keys off shift_id alone."""
    stepup(client)
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P",
                              "shift_id": shifts[1]["id"],
                              "in_time": "16:00", "out_time": "23:00"}])
    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["shift_id"] == shifts[1]["id"], "no button would light up"


def test_staff_without_a_default_shift_are_not_rostered_off(client, outlet_id, shifts):
    """"No shift configured" is not "day off". Treating it as off made the grid
    render an inert 'off' label with no button, so 14 of 15 staff could never
    be marked on any day."""
    stepup(client)
    r = client.post("/api/staff/employees", json={
        "name": "No Shift Yet", "outlet_id": outlet_id,
        "monthly_salary_rupees": 20000, "join_date": "2026-01-01"})
    assert r.status_code == 201, r.text
    eid = r.json()["id"]

    cell = grid_cell(client, outlet_id, eid)
    assert cell["off_day"] is False, "unscheduled staff cannot be marked at all"

    # ...and they can actually be marked
    assert bulk(client, outlet_id, [{"employee_id": eid, "status": "P"}]).status_code == 200
    assert grid_cell(client, outlet_id, eid)["row"]["status"] == "P"


def test_a_real_rostered_off_day_is_still_reported_as_off(client, outlet_id, emp, shifts):
    """The genuine case must keep working: a weekly pattern with no shift on
    that weekday really is a day off."""
    stepup(client)
    # TODAY is a Tuesday (dow 1); roster every other day, leave Tuesday blank.
    pattern = [{"dow": d, "shift_id": None if d == 1 else shifts[0]["id"]}
               for d in range(7)]
    r = client.patch(f"/api/staff/employees/{emp['id']}", json={"pattern": pattern})
    assert r.status_code == 200, r.text
    assert grid_cell(client, outlet_id, emp["id"])["off_day"] is True


def test_a_future_day_cannot_be_marked(client, outlet_id, emp):
    """Attendance records what happened; tomorrow has not happened."""
    stepup(client)
    from datetime import date, timedelta
    tomorrow = (date.today() + timedelta(days=1)).isoformat()

    r = bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P"}], day=tomorrow)
    assert r.status_code == 422, r.text

    r = client.post("/api/attendance/mark", json={
        "employee_id": emp["id"], "date": tomorrow, "status": "P"})
    assert r.status_code == 422, r.text


def test_today_can_still_be_marked(client, outlet_id, emp):
    """The future guard must not catch today itself."""
    stepup(client)
    from datetime import date
    today = date.today().isoformat()
    r = bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P"}], day=today)
    assert r.status_code == 200, r.text


def test_roster_overrides_may_still_be_planned_ahead(client, outlet_id, emp, shifts):
    """The future guard is opt-in: planning next week's roster must still work."""
    stepup(client)
    from datetime import date, timedelta
    future = (date.today() + timedelta(days=10)).isoformat()
    r = client.post("/api/staff/override", json={
        "employee_id": emp["id"], "date": future, "shift_id": shifts[1]["id"]})
    assert r.status_code in (200, 201), r.text


# --- doubles: worked twice, or missed twice --------------------------------

def test_a_double_absent_counts_as_two_days_missed(client, outlet_id, emp, shifts):
    stepup(client)
    assert bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "A",
                                     "double_duty": True}]).status_code == 200
    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["status"] == "A"
    assert row["double_duty"] is True, "the double absent did not stick"

    s = client.get(f"/api/attendance/month-summary?employee_id={emp['id']}"
                   "&year=2026&month=5").json()
    assert s["absents"] == 2, s


def test_a_double_absent_is_never_paid(client, outlet_id, emp, shifts):
    """The double bonus is an extra day WORKED. Crediting it for an absence
    would pay a full day's wage for not turning up."""
    stepup(client)
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "A",
                              "double_duty": True}])
    s = client.get(f"/api/attendance/month-summary?employee_id={emp['id']}"
                   "&year=2026&month=5").json()
    assert s["credited_days"] == 0.0, s
    assert s["doubles"] == 0, "an absence is not a double duty"


def test_a_worked_double_still_credits_two_days(client, outlet_id, emp, shifts):
    stepup(client)
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P",
                              "double_duty": True, "shift_id": shifts[0]["id"],
                              "in_time": "08:00", "out_time": "23:00"}])
    s = client.get(f"/api/attendance/month-summary?employee_id={emp['id']}"
                   "&year=2026&month=5").json()
    assert s["credited_days"] == 2.0, s
    assert s["doubles"] == 1, s


def test_a_double_shift_is_not_also_paid_as_overtime(client, outlet_id, emp, shifts):
    """Shift 1 ends 16:00 but a double runs to the end of Shift 2 (23:00).
    Measuring OT from 16:00 would pay the second shift twice."""
    stepup(client)
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P",
                              "double_duty": True, "shift_id": shifts[0]["id"],
                              "in_time": "08:00", "out_time": "23:00"}])
    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["ot_min"] == 0, f"second shift double-counted as {row['ot_min']} min OT"


def test_a_single_shift_overrun_is_still_overtime(client, outlet_id, emp, shifts):
    """The guard above must not switch overtime off for ordinary days."""
    stepup(client)
    bulk(client, outlet_id, [{"employee_id": emp["id"], "status": "P",
                              "shift_id": shifts[0]["id"],
                              "in_time": "08:00", "out_time": "18:00"}])
    row = grid_cell(client, outlet_id, emp["id"])["row"]
    assert row["ot_min"] > 0, "overtime stopped being recorded"
