"""A hand-entered sale must show up in the payment mix, not just the total.

Manual rows keep their figure in amount_paise and leave net_paise at zero -
only POS imports fill net_paise. The month summary used net_paise for the
"how money came in" card, so every shop that types its takings in by hand saw
Cash / UPI / Card all sitting at zero underneath a correct sales total. That
is the worst kind of wrong number: confident, prominent and quietly false.
"""
from datetime import date

TODAY = date.today().isoformat()


def _summary(client, outlet_id):
    r = client.get(f"/api/stats/dashboard?outlet_id={outlet_id}&month={TODAY[:7]}")
    assert r.status_code == 200, r.text
    return r.json()


def test_manual_sales_appear_in_the_payment_mix(client, outlet_id):
    for kind, amount in (("cash", 4000.0), ("upi", 6000.0)):
        r = client.put("/api/sales/manual", json={
            "outlet_id": outlet_id, "business_date": TODAY,
            "channel_kind": kind, "amount_rupees": amount})
        assert r.status_code == 200, r.text

    d = _summary(client, outlet_id)
    assert d["sales_total_rupees"] == 10000.0

    mix = {m["kind"]: m["net_rupees"] for m in d["modes"]}
    assert mix == {"cash": 4000.0, "upi": 6000.0}, \
        f"payment mix does not match what was entered: {mix}"
    # The mix must also add up to the headline, or the card contradicts the tile.
    assert sum(mix.values()) == d["sales_total_rupees"]
    assert d["sales_net_rupees"] == 10000.0
