import requests
import pandas as pd
from datetime import datetime
import os
from io import StringIO
from googleapiclient.discovery import build
from google.oauth2.service_account import Credentials

# Step 1: Fetch and Process Data from REDCap API
def fetch_and_process_redcap_data():
    # Define API URL and token
    api_url = "https://cphapps.temple.edu/redcap/api/"
    # Read API token from a text file for safety (avoids hardcoding sensitive data in the script)
    with open("/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/API_INFO/lite_redcap_api_token.txt", "r") as file:
        api_token = file.read().strip()


    # Set up the payload for the specific report
    payload = {
        "token": api_token,
        "content": "report",
        "format": "csv",
        "report_id": "8040",  # Correct report ID for STS1_STS2_COMPLETE_CHECK
        "rawOrLabel": "raw",
        "rawOrLabelHeaders": "raw"
    }

    # Make the API request
    response = requests.post(api_url, data=payload)

    # Check for errors
    if response.status_code != 200:
        raise Exception(f"Error: {response.status_code}, {response.text}")

    # Load the data into a pandas DataFrame using io.StringIO
    data = pd.read_csv(StringIO(response.text))

    # Pivot the data to have one row per record_id
    combined_data = data.pivot_table(
        index="record_id",                  # The unique identifier for each participant
        columns="redcap_event_name",       # Event names to create new columns
        aggfunc="first"                    # Use the first value for each variable
    )

    # Flatten the multi-level column index
    combined_data.columns = [f"{col[1]}_{col[0]}" for col in combined_data.columns]
    combined_data.reset_index(inplace=True)

    # Reorder columns
    desired_columns = [
        "record_id",
        "screen_time_y1_arm_1_screen_time_1_complete",
        "screen_time_y1_arm_1_screen_time_2_complete",
        "screen_time_y1_arm_1_screen_time_3_complete",
        "screen_time_y1_arm_1_screen_time_4_complete",
        "screen_time_y1_arm_1_screen_time_5_complete",
        "screen_time_y1_arm_1_screen_time_6_complete",
        "screen_time_2_y1_arm_1_screen_time_1_2_complete",
        "screen_time_2_y1_arm_1_screen_time_2_2_complete",
        "screen_time_2_y1_arm_1_screen_time_3_2_complete"
    ]

    # Filter and reorder the columns in the DataFrame
    combined_data = combined_data[desired_columns]

    # Generate the output filename with today's date
    today = datetime.now().strftime("%Y-%m-%d")
    output_filename = f"sts_check_{today}.csv"

    # Define the output directory
    output_dir = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/FollowupCheck/w1checkoutput/"
    os.makedirs(output_dir, exist_ok=True)

    # Save the file to the specified directory
    output_path = os.path.join(output_dir, output_filename)
    combined_data.to_csv(output_path, index=False)

    print(f"Data successfully saved to {output_path}")
    return output_path

# Step 2: Authenticate with Google Sheets API
def authenticate_google_sheets(credentials_file):
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(credentials_file, scopes=scopes)
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    return service

# Step 3: Clear Google Sheets Tab
def clear_sheet(service, spreadsheet_id, sheet_name):
    range_to_clear = f"'{sheet_name}'!A1:Z1000"  # Explicit range
    service.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range=range_to_clear
    ).execute()
    print(f"Cleared all data in tab: {sheet_name}")

# Step 4: Write Data to Google Sheets
def write_csv_to_sheet(service, spreadsheet_id, sheet_name, csv_file_path):
    csv_data = pd.read_csv(csv_file_path).fillna("")
    values = [csv_data.columns.tolist()] + csv_data.values.tolist()  # Include headers

    range_to_update = f"'{sheet_name}'!A1"  # Start writing from the first cell
    body = {"values": values}
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=range_to_update,
        valueInputOption="RAW",
        body=body
    ).execute()
    print(f"Replaced data in tab: {sheet_name} with CSV content")

# Step 5: Main Workflow
def main():
    # File paths and IDs
    credentials_file = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/Google_API/arcane-boulder-445318-e0-ae3efe15a20e.json"
     # Read Google Sheets spreadsheet ID from a text file for safety
    with open("/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/API_INFO/sessionnotes-googleid.txt", "r") as file:
        spreadsheet_id = file.read().strip()
    sheet_name = "sts1w1"

    # Fetch and process data from REDCap
    csv_file_path = fetch_and_process_redcap_data()

    # Authenticate with Google Sheets
    service = authenticate_google_sheets(credentials_file)

    # Clear the existing tab and write the new data
    clear_sheet(service, spreadsheet_id, sheet_name)
    write_csv_to_sheet(service, spreadsheet_id, sheet_name, csv_file_path)

    print("Data successfully fetched from REDCap and uploaded to Google Sheets!")

if __name__ == "__main__":
    main()
