# QuickBooks customer import — accounts receivable

Phase 1 imports **customers only** (for accounts receivable). No invoices,
no balances, no payments are imported in Phase 1. That is deliberate:
importing open balances without the underlying invoices would create
receivables that don't tie to any ticket. Open invoice balances are a
Phase 3 import, once invoices exist in this system.

No live QuickBooks API / OAuth is built in Phase 1. Export a CSV from
QuickBooks, upload it in the app (Admin → Import), review the preview,
then import the rows you select.

## Template

Download the template from the Import screen, or use these headers:

```
Company, Contact, Phone, Email, Billing Address, Billing City, Billing State, Billing ZIP, Terms, Tax Exempt
```

- `Company` — required. This is the customer record name.
- `Tax Exempt` — `Yes` / `No` (also accepts Y, True, 1).
- `Terms` — e.g. `Net 30`. Blank defaults to `Net 30`.

## QuickBooks Online — export customers

1. QuickBooks Online → Sales → Customers (or Customers & leads).
2. Click the gear / export icon → **Export to Excel** (or Export).
3. Open the export in Excel / Google Sheets.
4. Rename / rearrange columns to match the template headers above.
   QBO's usual columns map like this:

| QBO export column | Template column |
|---|---|
| Customer / Display Name | Company |
| Primary contact / Contact name | Contact |
| Phone | Phone |
| Email | Email |
| Billing Address (street) | Billing Address |
| Billing City | Billing City |
| Billing State | Billing State |
| Billing ZIP / Postal code | Billing ZIP |
| Terms | Terms |
| Tax exempt / Taxable | Tax Exempt (`Yes` if exempt) |

5. Save as **CSV** (File → Save As → CSV, or Download → CSV).
6. Upload in the app: Admin → Import → Choose CSV file.

Notes:
- QBO sometimes exports the billing address as one combined field.
  Split it into street / city / state / ZIP in the spreadsheet before
  uploading, or leave city/state/ZIP blank — they are optional.
- If a customer has multiple contacts, put the main one on the row.
  Extra contacts can be added in the app after import.

## QuickBooks Desktop — export customers

1. QuickBooks Desktop → Customers → Customer Center.
2. Select the customers to export (or all), then **Excel → Export Customer List**,
   or File → Utilities → Export → Lists to IIF / CSV.
   The cleanest route is the Customer List export to Excel.
3. In Excel, keep one row per customer and rename columns to the template:

| QB Desktop column | Template column |
|---|---|
| Customer / Name | Company |
| Contact | Contact |
| Phone | Phone |
| Email | Email |
| Bill To / Address | Billing Address |
| City | Billing City |
| State | Billing State |
| ZIP | Billing ZIP |
| Terms | Terms |
| Tax Exempt (Y/N) | Tax Exempt |

4. Save as **CSV** and upload in the app.

Notes:
- Desktop "Customer:Job" names (e.g. `Acme Corp:Shop 2`) come through as
  one Company name. Split them into separate customers in the spreadsheet
  if you want them separate here.
- Desktop IIF files are **not** CSV — do not upload an `.iif` file.
  Export to Excel first, then save as CSV.

## Duplicate detection (preview, before anything is imported)

A row is flagged in the preview if:
- the Company name already exists (case-insensitive), or
- the phone number already exists on a contact, or
- the email address already exists on a contact.

Flagged rows are **unchecked by default**. You can still check one and
import it if it is genuinely a second location / second contact — the
flag is a warning, not a block. Nothing is imported until you click
"Import selected customers".

## After import

- Check a few customers in Customers → open the record → confirm the
  contact and billing address came through.
- Add vehicles for each customer (Vehicles tab) — QuickBooks does not
  carry VIN / fleet-unit data, so vehicles are entered here.
- Open balances / unpaid invoices are **not** imported in Phase 1.
  Keep them in QuickBooks until the Phase 3 receivables import, and
  keep QuickBooks as the system of record for money until then.
