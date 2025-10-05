import pandas as pd
import requests
from datetime import datetime
from io import StringIO
from googleapiclient.discovery import build
from google.oauth2.service_account import Credentials

# === CONFIGURATION ===
google_creds_path = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/Google_API/arcane-boulder-445318-e0-ae3efe15a20e.json"
with open("/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/API_INFO/sessionnotes-googleid.txt", "r") as f:
    spreadsheet_id = f.read().strip()
sheet_name = "Follow up.2"
redcap_api_url = "https://cphapps.temple.edu/redcap/api/"
with open("/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/API_INFO/lite_redcap_api_token.txt", "r") as f:
    redcap_api_token = f.read().strip()
redcap_report_id = 8244

# === OUTPUT FILES ===
google_csv = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/stsemaimport/Wave-2/google_participants_with_dates.csv"
redcap_csv = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/stsemaimport/Wave-2/redcap_participants.csv"
intersection_csv = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/stsemaimport/Wave-2/intersection_participants.csv"

# === FUNCTIONS ===

def fetch_google_data():
    credentials = Credentials.from_service_account_file(google_creds_path)
    service = build('sheets', 'v4', credentials=credentials)
    
    range_a = f"{sheet_name}!A:A"
    range_v = f"{sheet_name}!V:V"
    
    result = service.spreadsheets().values().batchGet(
        spreadsheetId=spreadsheet_id, 
        ranges=[range_a, range_v]
    ).execute()
    
    col_a = result['valueRanges'][0].get("values", [])
    col_v = result['valueRanges'][1].get("values", [])

    max_len = max(len(col_a), len(col_v))
    data = []
    for i in range(max_len):
        record_id = col_a[i][0].strip() if i < len(col_a) and col_a[i] else ""
        ema_date = col_v[i][0].strip() if i < len(col_v) and col_v[i] else ""
        if record_id and ema_date:
            data.append([record_id, ema_date])
    
    df = pd.DataFrame(data, columns=["record_id", "ema_start_day"])
    df.to_csv(google_csv, index=False)
    print(f"Saved Google Sheet data with EMA dates to: {google_csv}")
    return df

def fetch_redcap_data():
    payload = {
        "token": redcap_api_token,
        "content": "report",
        "format": "csv",
        "report_id": redcap_report_id,
        "rawOrLabel": "raw",
        "rawOrLabelHeaders": "raw",
        "exportBlankForGrayFormStatus": "true"
    }
    
    response = requests.post(redcap_api_url, data=payload)
    if response.status_code != 200:
        raise Exception(f"REDCap error: {response.status_code} - {response.text}")
    
    df = pd.read_csv(StringIO(response.text), header=None)
    df = df.rename(columns={0: "record_id"})
    df = df[["record_id"]].dropna()
    df["record_id"] = df["record_id"].astype(str).str.strip()
    df.to_csv(redcap_csv, index=False)
    print(f"Saved REDCap report data to: {redcap_csv}")
    return df

def get_intersection(google_df, redcap_df):
    google_ids = set(google_df["record_id"].astype(str).str.strip())
    redcap_ids = set(redcap_df["record_id"].astype(str).str.strip())
    common_ids = google_ids & redcap_ids

    intersected = google_df[google_df["record_id"].isin(common_ids)].copy()

    # Format EMA date
    def format_date(date_str):
        try:
            datetime.strptime(date_str, "%Y-%m-%d %H:%M")
            return date_str
        except Exception:
            print(f"⚠️ Skipping invalid date: {date_str}")
            return None

    intersected["ema_start_day"] = intersected["ema_start_day"].apply(format_date)
    intersected = intersected.dropna(subset=["ema_start_day"])
    
    intersected.to_csv(intersection_csv, index=False)
    print(f"Saved intersection data to: {intersection_csv}")
    return intersected

def build_redcap_payload(intersection_df):
    payload = []
    for _, row in intersection_df.iterrows():
        payload.append({
            "record_id": row["record_id"],
            "redcap_event_name": "ema_y2_arm_1",
            "ema_start_day": row["ema_start_day"],
            "ema_enable": 1,
            "ema_settings_complete": 2
        })
    return payload

def import_to_redcap(records):
    payload = {
        "token": redcap_api_token,
        "content": "record",
        "format": "json",
        "type": "flat",
        "overwriteBehavior": "normal",
        "data": pd.DataFrame(records).to_json(orient="records"),
        "returnContent": "count",
        "returnFormat": "json"
    }

    response = requests.post(redcap_api_url, data=payload)
    if response.status_code != 200:
        raise Exception(f"Failed to import to REDCap: {response.status_code}, {response.text}")
    print(f"✅ Successfully imported to REDCap: {response.text}")

# === MAIN SCRIPT ===
def main():
    google_df = fetch_google_data()
    redcap_df = fetch_redcap_data()
    intersection_df = get_intersection(google_df, redcap_df)
    records = build_redcap_payload(intersection_df)

    if not records:
        print("No valid records to import.")
        return

    import_to_redcap(records)

if __name__ == "__main__":
    main()
