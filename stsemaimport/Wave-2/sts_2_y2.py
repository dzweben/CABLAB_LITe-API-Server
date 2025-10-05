import os
import pandas as pd
from googleapiclient.discovery import build
from google.oauth2.service_account import Credentials
import requests
from io import StringIO
from datetime import datetime

# File paths and configuration
google_creds_path = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/Google_API/arcane-boulder-445318-e0-ae3efe15a20e.json"
with open("/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/API_INFO/sessionnotes-googleid.txt", "r") as f:
    spreadsheet_id = f.read().strip()
sheet_name = "Follow up.2"
google_output_csv = "google_sheet_data_sts_2_y2.csv"
redcap_api_url = "https://cphapps.temple.edu/redcap/api/"
with open("/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/API_INFO/lite_redcap_api_token.txt", "r") as f:
    redcap_api_token = f.read().strip()
redcap_report_id = 8242
redcap_output_csv = "redcap_report_data_sts_2_y2.csv"
intersection_csv = "intersection_data_sts_2_y2.csv"

# Step 1: Fetch and process Google Sheet data (Column A and Column N)
def fetch_google_sheet_data():
    credentials = Credentials.from_service_account_file(google_creds_path)
    service = build('sheets', 'v4', credentials=credentials)
    
    range_a = f"{sheet_name}!A:A"
    range_n = f"{sheet_name}!AA:AA"
    
    result_a = service.spreadsheets().values().get(spreadsheetId=spreadsheet_id, range=range_a).execute()
    result_n = service.spreadsheets().values().get(spreadsheetId=spreadsheet_id, range=range_n).execute()
    
    values_a = result_a.get("values", [])
    values_n = result_n.get("values", [])
    
    max_rows = max(len(values_a), len(values_n))
    data = []
    for i in range(max_rows):
        row_a = values_a[i][0] if i < len(values_a) and values_a[i] else ""
        row_n = values_n[i][0] if i < len(values_n) and values_n[i] else ""
        data.append([row_a, row_n])
    
    df = pd.DataFrame(data, columns=["record_id", "month_year"])
    df = df[df["month_year"].str.match(r"\d{2}/\d{4}", na=False)]
    return df

# Step 2: Fetch and process REDCap data
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
        raise Exception(f"Error fetching REDCap report: {response.status_code}, {response.text}")
    
    data = pd.read_csv(StringIO(response.text), header=None)
    return data

# Step 3: Find intersection of values in the first column and add first-of-month dates
def find_intersection(google_data, redcap_data):
    google_ids = google_data["record_id"].dropna().astype(str).str.strip()
    redcap_ids = redcap_data.iloc[:, 0].dropna().astype(str).str.strip()

    intersection = list(set(google_ids) & set(redcap_ids))
    google_dict = dict(zip(google_data["record_id"].astype(str).str.strip(), google_data["month_year"]))

    intersection_with_dates = []
    for record_id in intersection:
        month_year = google_dict.get(record_id)
        try:
            # Changed day from 1 to 20
            first_of_month = datetime.strptime(month_year, "%m/%Y").replace(day=21, hour=18, minute=45)
            intersection_with_dates.append({
                "record_id": record_id,
                "date": first_of_month.strftime("%Y-%m-%d %H:%M")
            })
        except Exception as e:
            print(f"Skipping {record_id} due to date parsing error: {e}")

    return pd.DataFrame(intersection_with_dates)
# Step 4: Prepare REDCap import payload
def prepare_redcap_import(intersection_data):
    records = []
    for _, row in intersection_data.iterrows():
        records.append({
            "record_id": row["record_id"],
            "redcap_event_name": "screen_time_2_y2_arm_1",
            "screen_time_2_1_date": row["date"],
            "screen_time_cycle_2": 1,
            "screen_time_settings_2_complete": 2,
        })
    return records

# Step 5: Import data to REDCap
def import_data_to_redcap(records):
    payload = {
        "token": redcap_api_token,
        "content": "record",
        "format": "json",
        "type": "flat",
        "overwriteBehavior": "normal",
        "data": pd.DataFrame(records).to_json(orient="records"),
        "returnContent": "count",
        "returnFormat": "json",
    }

    response = requests.post(redcap_api_url, data=payload)
    if response.status_code != 200:
        raise Exception(f"Error importing data to REDCap: {response.status_code}, {response.text}")
    
    print(f"Successfully imported data to REDCap: {response.text}")

# Main execution
def main():
    google_data = fetch_google_sheet_data()
    google_data.to_csv(google_output_csv, index=False)
    print(f"Filtered Google Sheet data saved to {google_output_csv}.")

    redcap_data = fetch_redcap_data()
    redcap_data.to_csv(redcap_output_csv, index=False, header=False)
    print(f"REDCap report data saved to {redcap_output_csv}.")

    intersection_data = find_intersection(google_data, redcap_data)
    intersection_data.to_csv(intersection_csv, index=False)
    print(f"Intersection data saved to {intersection_csv}.")

    records = prepare_redcap_import(intersection_data)

    import_data_to_redcap(records)


if __name__ == "__main__":
    main()
