from datetime import date


def body(client, outlet_id, amount=321):
    category = client.get("/api/lists/categories").json()[0]
    return {
        "outlet_id": outlet_id, "business_date": date.today().isoformat(),
        "category_id": category["id"], "amount_rupees": amount,
        "mode": "upi", "description": "vegetables",
    }


def test_manual_expense_requires_confirmation_for_exact_date_amount_match(client, outlet_id):
    first = client.post("/api/expenses", json=body(client, outlet_id))
    assert first.status_code == 201

    duplicate = client.post("/api/expenses", json={
        **body(client, outlet_id), "description": "second vegetables entry",
    })
    assert duplicate.status_code == 409
    detail = duplicate.json()["detail"]
    assert detail["code"] == "possible_duplicate"
    assert detail["candidates"][0]["id"] == first.json()["id"]

    confirmed = client.post("/api/expenses", json={
        **body(client, outlet_id), "confirm_possible_duplicate": True,
    })
    assert confirmed.status_code == 201


def test_statement_preview_flags_existing_manual_expense(client, outlet_id):
    existing = client.post("/api/expenses", json=body(client, outlet_id, 123)).json()
    day = date.today().strftime("%d/%m/%y")
    raw = (
        "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n"
        f"{day},UPI-TEST SHOP-testshop@okaxis-X-1,,{day},123.00,,1000.00\n"
    ).encode()
    preview = client.post(
        f"/api/bank/upload?outlet_id={outlet_id}",
        files={"file": ("statement.csv", raw, "text/csv")},
    )
    assert preview.status_code == 200
    row = preview.json()["transactions"][0]
    assert row["possible_duplicates"][0]["id"] == existing["id"]
    assert preview.json()["payees"][0]["possible_duplicate_count"] == 1


def test_statement_commit_can_include_only_selected_possible_duplicates(
        client, outlet_id):
    category = client.get("/api/lists/categories").json()[0]
    day = date.today().strftime("%d/%m/%y")
    for amount in (123, 456):
        created = client.post("/api/expenses", json={
            "outlet_id": outlet_id, "business_date": date.today().isoformat(),
            "category_id": category["id"], "amount_rupees": amount,
            "mode": "upi", "description": f"existing {amount}",
        })
        assert created.status_code == 201
    raw = (
        "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n"
        f"{day},UPI-TEST SHOP-testshop@okaxis-X-1,,{day},123.00,,1000.00\n"
        f"{day},UPI-TEST SHOP-testshop@okaxis-X-2,,{day},456.00,,544.00\n"
    ).encode()
    preview = client.post(
        f"/api/bank/upload?outlet_id={outlet_id}",
        files={"file": ("statement.csv", raw, "text/csv")},
    ).json()
    rows = preview["transactions"]
    assert all(row["possible_duplicates"] for row in rows)

    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    result = client.post(f"/api/bank/{preview['batch_id']}/commit", json={
        "decisions": [{
            "match_key": "testshop@okaxis", "category_id": category["id"],
            "mode": "upi",
            "include_possible_duplicate_hashes": [rows[0]["hash"]],
        }],
    })
    assert result.status_code == 200, result.text
    assert result.json()["created"] == 1
    assert result.json()["possible_duplicates_skipped"] == 1
