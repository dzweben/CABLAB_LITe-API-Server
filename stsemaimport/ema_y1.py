import os
import pandas as pd
from googleapiclient.discovery import build
from google.oauth2.service_account import Credentials
import requests
from io import StringIO
from datetime import datetime, timedelta
import calendar

# File paths and configuration
google_creds_path = "/Users/tur50045/Desktop/LITE-Server/sessionotessecurity/arcane-boulder-445318-e0-ae3efe15a20e.json"
spreadsheet_id = "18LScSoBcT8XmwA_WjfeN4Lt2PZESDm7FycAqocZ1cH4"
sheet_name = "Follow up.1"
google_output_csv = "google_sheet_data_v3.csv"
redcap_api_url = "https://cphapps.temple.edu/redcap/api/"
redcap_api_token = "6E4C4AEFF6A66B2AC62EFCB8BB9246D5"
redcap_report_id = 8187
redcap_output_csv = "redcap_report_data_v3.csv"
intersection_csv = "intersection_data_v3.csv"

# Set the time interval for filtering (in days)
date_filter_days = 365  # Change this value to adjust the time length (e.g., 60 for two months)

# Step 1: Fetch and process Google Sheet data
def fetch_google_sheet_data():
    credentials = Credentials.from_service_account_file(google_creds_path)
    service = build('sheets', 'v4', credentials=credentials)
    
    # Fetch column A
    range_a = f"{sheet_name}!A:A"
    result_a = service.spreadsheets().values().get(spreadsheetId=spreadsheet_id, range=range_a).execute()
    values_a = result_a.get("values", [])
    
    # Fetch column N
    range_n = f"{sheet_name}!N:N"
    result_n = service.spreadsheets().values().get(spreadsheetId=spreadsheet_id, range=range_n).execute()
    values_n = result_n.get("values", [])
    
    # Combine the two columns into a single DataFrame
    max_rows = max(len(values_a), len(values_n))
    data = []
    for i in range(max_rows):
        row_a = values_a[i][0] if i < len(values_a) and values_a[i] else ""
        row_n = values_n[i][0] if i < len(values_n) and values_n[i] else ""
        data.append([row_a, row_n])
    
    df = pd.DataFrame(data, columns=["Column A", "Column N"])
    
    # Filter rows where "Column N" is a valid date within the interval
    today = datetime.now()
    cutoff_date = today - timedelta(days=date_filter_days)
    
    def is_valid_date(value):
        try:
            # Parse and check the date
            parsed_date = datetime.strptime(value, "%m/%d/%Y")  # Adjust format as needed
            return parsed_date >= cutoff_date
        except (ValueError, TypeError):
            return False

    # Apply the date filter
    df_filtered = df[df["Column N"].apply(is_valid_date)]
    return df_filtered

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
    
    # Make the API request
    response = requests.post(redcap_api_url, data=payload)
    if response.status_code != 200:
        raise Exception(f"Error fetching REDCap report: {response.status_code}, {response.text}")
    
    # Parse the CSV response into a DataFrame
    data = pd.read_csv(StringIO(response.text), header=None)  # Ignore column headers
    return data

# Step 3: Find intersection of values in the first column and add dates
def find_intersection(google_data, redcap_data):
    # Extract the first column from both datasets
    google_column_a = google_data.iloc[:, 0].dropna().astype(str).str.strip()
    redcap_column_a = redcap_data.iloc[:, 0].dropna().astype(str).str.strip()

    # Find the intersection of values
    intersection_values = list(set(google_column_a) & set(redcap_column_a))
    
    # Add corresponding dates from Google Sheet
    google_dict = dict(zip(google_data["Column A"].astype(str).str.strip(), google_data["Column N"]))
    intersection_with_dates = [
        {"record_id": value, "date": google_dict.get(value, "")} for value in intersection_values
    ]
    
    # Convert to DataFrame
    intersection_df = pd.DataFrame(intersection_with_dates)
    return intersection_df

# Step 4: Create payload for REDCap import
def prepare_redcap_import(intersection_data):
    records = []
    
    for _, row in intersection_data.iterrows():
        record_id = row["record_id"]
        base_date = datetime.strptime(row["date"], "%m/%d/%Y")
        
        # Calculate the first Monday 7 months after the base date
        target_date = base_date + timedelta(days=7 * 30)  # Approximate 7 months
        first_day_of_month = datetime(target_date.year, target_date.month, 1)
        first_monday = first_day_of_month + timedelta(days=(7 - first_day_of_month.weekday()) % 7)
        new_date = first_monday.replace(hour=0, minute=0)
        
        record = {
            "record_id": record_id,
            "redcap_event_name": "ema_y1_arm_1",  # Updated event name
            "ema_start_day": new_date.strftime("%Y-%m-%d %H:%M"),  # Updated field name
            "ema_enable": 1,  # Updated field name
            "ema_settings_complete": 2,  # Updated field name
        }
        records.append(record)
    
    return records

# Step 5: Import data into REDCap
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

# Main function to orchestrate data processing
def main():
    # Process Google Sheet data
    google_data = fetch_google_sheet_data()
    google_data.to_csv(google_output_csv, index=False)
    print(f"Filtered Google Sheet data saved to {google_output_csv}.")
    
    # Process REDCap data
    redcap_data = fetch_redcap_data()
    redcap_data.to_csv(redcap_output_csv, index=False, header=False)
    print(f"REDCap report data saved to {redcap_output_csv}.")
    
    # Find and save intersection data
    intersection_data = find_intersection(google_data, redcap_data)
    intersection_data.to_csv(intersection_csv, index=False)
    print(f"Intersection data saved to {intersection_csv}.")
    
    # Prepare import payload
    records = prepare_redcap_import(intersection_data)
    
    # Import data into REDCap
    import_data_to_redcap(records)

if __name__ == "__main__":
    main()
