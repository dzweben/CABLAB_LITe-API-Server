# 📊 REDCap to Google Sheets Automation

These scripts automate tracking of long-term virtual survey completion by pulling data from REDCap and updating team-facing Google Sheets for each wave of the project.

They run automatically as scheduled cron jobs and require no manual input once set up.

---

## What They Do

- Fetch REDCap report data (e.g., survey completion fields for STS1 and STS2)
- Pivot and filter the data, then save dated `.csv` files
- Authenticate via service account and connect to Google Sheets
- Clear existing data in the relevant sheet tabs (e.g., `sts1w1`, `sts2w1`)
- Upload the latest survey completion data to the correct tab

---

## File Setup

- **REDCap token:**  
  `API_INFO/lite_redcap_api_token.txt`

- **Google credentials:**  
  `Google_API/arcane-boulder-445318-xxxx.json`

- **Google Sheet ID:**  
  `API_INFO/sessionnotes-googleid.txt`

- **Output CSVs:**  
  `FollowupCheck/w1checkoutput/`

---

## Notes

- These scripts work in conjunction with the **Conditional Formatting** scripts  
  in the `Conditional Formatting/` folder, which highlight cells throughout  
  the participant tracking spreadsheet based on the output of these scripts.
- Ensure all token and credential files are valid and stored securely.
