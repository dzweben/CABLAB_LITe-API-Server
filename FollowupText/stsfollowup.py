import requests
import smtplib
import pandas as pd
from datetime import datetime
from io import StringIO
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import os
import re
import glob



# Define API details
api_url = "https://cphapps.temple.edu/redcap/api/"
api_token = "6E4C4AEFF6A66B2AC62EFCB8BB9246D5"

# Define the map from columns to events/instruments
date_to_instrument_map = {
    "screen_time_1_1_date": ("screen_time_y1_arm_1", "screen_time_1"),
    "screen_time_1_2_date": ("screen_time_y1_arm_1", "screen_time_2"),
    "screen_time_1_3_date": ("screen_time_y1_arm_1", "screen_time_3"),
    "screen_time_1_4_date": ("screen_time_y1_arm_1", "screen_time_4"),
    "screen_time_1_5_date": ("screen_time_y1_arm_1", "screen_time_5"),
    "screen_time_1_6_date": ("screen_time_y1_arm_1", "screen_time_6"),
    "screen_time_2_1_date": ("screen_time_2_y1_arm_1", "screen_time_1_2"),
    "screen_time_2_2_date": ("screen_time_2_y1_arm_1", "screen_time_2_2"),
    "screen_time_2_3_date": ("screen_time_2_y1_arm_1", "screen_time_3_2"),
}

# Helper function to fetch REDCap report
def fetch_redcap_report(report_id):
    payload = {
        "token": api_token,
        "content": "report",
        "format": "csv",
        "report_id": report_id,
        "rawOrLabel": "raw",
        "rawOrLabelHeaders": "raw"
    }
    response = requests.post(api_url, data=payload)
    if response.status_code != 200:
        raise Exception(f"Error fetching REDCap report {report_id}: {response.status_code}, {response.text}")
    return pd.read_csv(StringIO(response.text))

# Fetch the first name for a specific record_id
def fetch_first_name(record_id):
    payload = {
        "token": api_token,
        "content": "record",
        "format": "json",
        "records[0]": record_id,
        "fields[0]": "first_name",
        "events[0]": "preenrollment_arm_1"
    }
    response = requests.post(api_url, data=payload)
    if response.status_code != 200:
        print(f"Failed to fetch first name for record {record_id}: {response.text}")
        return None

    try:
        response_data = response.json()
        if response_data and "first_name" in response_data[0]:
            return response_data[0]["first_name"]
        else:
            return None
    except Exception as e:
        print(f"Error parsing response for record {record_id}: {e}")
        return None

# Fetch the email for a specific record_id
def fetch_email(record_id):
    payload = {
        "token": api_token,
        "content": "record",
        "format": "json",
        "records[0]": record_id,
        "fields[0]": "email",
        "events[0]": "preenrollment_arm_1"
    }
    response = requests.post(api_url, data=payload)
    if response.status_code != 200:
        print(f"Failed to fetch email for record {record_id}: {response.text}")
        return None

    try:
        response_data = response.json()
        if response_data and "email" in response_data[0]:
            return response_data[0]["email"]
        else:
            return None
    except Exception as e:
        print(f"Error parsing response for record {record_id}: {e}")
        return None

# Define match_contacts function
def match_contacts(record_id, contacts_df):
    record_id_str = str(record_id)
    regex_pattern = fr"(?:^|[\s/]){re.escape(record_id_str)}(?:$|[\s/]|child|parent)"
    matched_rows = contacts_df[contacts_df["firstName"].str.contains(regex_pattern, na=False, case=False, regex=True)]
    return matched_rows

# Define the processing function to generate a completion matrix
def generate_completion_matrix(data, date_columns, complete_columns):
    date_columns = [col for col in date_columns if col in data.columns]
    complete_columns = [col for col in complete_columns if col in data.columns]

    for col in date_columns:
        data[col] = pd.to_datetime(data[col], errors="coerce")

    for col in complete_columns:
        data[col] = data[col].astype(str).str.strip()

    result = pd.DataFrame()
    for date_col, complete_col in zip(date_columns, complete_columns):
        data["month"] = data[date_col].dt.to_period("M")
        subtable = data[["record_id", "month", complete_col]].copy()
        subtable.rename(columns={complete_col: "status"}, inplace=True)
        subtable["status"] = subtable.apply(
            lambda row: "NA" if pd.isna(row["month"]) else ("2" if row["status"] == "2" else "0"),
            axis=1
        )
        result = pd.concat([result, subtable])

    completion_matrix = result.pivot_table(
        index="record_id",
        columns="month",
        values="status",
        aggfunc="first",
        fill_value="NA"
    )
    return completion_matrix

# Fetch the survey link for a specific record, event, and instrument
def fetch_survey_link(record_id, event_name, instrument):
    payload = {
        "token": api_token,
        "content": "surveyLink",
        "format": "json",
        "record": record_id,
        "event": event_name,
        "instrument": instrument,
    }
    response = requests.post(api_url, data=payload)
    
    # Check for HTTP errors
    if response.status_code != 200:
        return None

    # Handle raw text response for survey link
    survey_link = response.text.strip()
    if survey_link.startswith("http"):  # Ensure it's a valid link
        return survey_link
    else:
        return None

# Merge with contacts.csv
def enhance_with_contacts_and_text(missed_surveys_df, contacts_file):
    contacts_df = pd.read_csv(contacts_file)

    enhanced_data = []
    for _, row in missed_surveys_df.iterrows():
        record_id = row["record_id"]
        matching_contacts = match_contacts(record_id, contacts_df)
        if not matching_contacts.empty:
            for _, contact_row in matching_contacts.iterrows():
                new_row = row.copy()
                new_row["firstName"] = contact_row["firstName"]
                new_row["id"] = contact_row["id"]
                new_row["phone_number_1"] = contact_row["phone_number_1"]
                enhanced_data.append(new_row)
        else:
            new_row = row.copy()
            new_row["firstName"] = None
            new_row["id"] = None
            new_row["phone_number_1"] = None
            enhanced_data.append(new_row)
    
    enhanced_df = pd.DataFrame(enhanced_data)

    # Handle text and text-2 with deduplication
    phone_group = enhanced_df.groupby("phone_number_1")
    enhanced_df["text"] = None
    enhanced_df["text-2"] = None

    for phone, group in phone_group:
        if phone and not group.empty:
            first_row_idx = group.index[0]
            links = "\n".join(
                f"Link for {row['redcap-name'] or 'Participant'}: {row['survey_link']}" 
                for _, row in group.iterrows() if pd.notna(row["survey_link"])
            )
            if pd.notna(links):
                enhanced_df.loc[first_row_idx, "text"] = (
                    f"Hello! This is the Project LITe team at Temple University. We’re sending a quick reminder about the "
                    f"screen time survey for this month. This survey is part of the at-home portion of this wave. As a reminder, "
                    f"you’ll receive $70 for completing all surveys throughout the year. If the survey is partially completed, "
                    f"please re-start it to ensure we receive your responses. Thank you so much for your continued participation "
                    f"and support of our research!\n\n{links}"
                )
                enhanced_df.loc[first_row_idx, "text-2"] = (
                    f"Hello! This is the Project LITe team at Temple University. We’re just sending one last quick reminder about the "
                    f"screen time survey for this month. This survey is part of the at-home portion of this wave. "
                    f"\n\n{links}"
                )

     # Handle email content with deduplication
    enhanced_df["email_content"] = None

    # Iterate over each group of 'email' duplicates
    for email, group in enhanced_df.groupby("email"):
        if pd.notna(email) and not group.empty:
            # Combine links for all rows in the group
            links = "\n".join(
                f"Link for {row['redcap-name'] or 'Participant'}: {row['survey_link']}"
                for _, row in group.iterrows() if pd.notna(row["survey_link"])
            )

            # Find the index of the first row in the group
            first_row_idx = group.index[0]  # Index of the first row in the group

            # Assign email content for the first row and clear for duplicates
            for idx, row in group.iterrows():
                if idx == first_row_idx:
                    # Assign email_content to the first row in the group
                    enhanced_df.loc[idx, "email_content"] = (
                        f"Hello,\n\n"
                        f"This is the Project LITe team at Temple University. We’re sending a quick reminder to complete the screen time survey for this month. "
                        f"This survey is part of the at-home portion of this wave, and as a reminder, you’ll receive $70 for completing all surveys throughout the year.\n\n"
                        f"{links}\n\n"
                        f"If you have already started the survey but haven’t finished, please re-start it to ensure we receive your complete responses.\n\n"
                        f"Thank you so much for your continued participation and support of our research! If you have any questions or need assistance, feel free to reach out.\n\n"
                        f"Best regards,\n"
                        f"The Project LITe Team\n"
                        f"Temple University"
                    )
                else:
                    # Set email_content to None for subsequent duplicates
                    enhanced_df.loc[idx, "email_content"] = None

    return enhanced_df

# Fetch the data from both reports
data_1 = fetch_redcap_report(6465)
data_2 = fetch_redcap_report(6687)

date_columns_1 = [
    "screen_time_1_1_date", "screen_time_1_2_date", "screen_time_1_3_date",
    "screen_time_1_4_date", "screen_time_1_5_date", "screen_time_1_6_date"
]

complete_columns_1 = [
    "screen_time_1_complete", "screen_time_2_complete", "screen_time_3_complete",
    "screen_time_4_complete", "screen_time_5_complete", "screen_time_6_complete"
]

date_columns_2 = [
    "screen_time_2_1_date", "screen_time_2_2_date", "screen_time_2_3_date"
]

complete_columns_2 = [
    "screen_time_1_2_complete", "screen_time_2_2_complete", "screen_time_3_2_complete"
]

completion_matrix_1 = generate_completion_matrix(data_1, date_columns_1, complete_columns_1)
completion_matrix_2 = generate_completion_matrix(data_2, date_columns_2, complete_columns_2)

merged_completion_matrix = completion_matrix_1.combine_first(completion_matrix_2)

def resolve_na_elementwise(row1, row2):
    return row1.where(row1 != "NA", row2)

merged_completion_matrix = merged_completion_matrix.combine(completion_matrix_2, resolve_na_elementwise)

output_dir = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/FollowupText/"
os.makedirs(output_dir, exist_ok=True)

# Generate the incompletion report
incompletion_report = merged_completion_matrix.apply(lambda x: x.map(lambda y: "0" if y == "0" else None)).stack().reset_index()
incompletion_report.columns = ["record_id", "month", "status"]
incompletion_report = incompletion_report.drop("status", axis=1)
incompletion_report_file = os.path.join(output_dir, "incompletion_report.csv")
incompletion_report.to_csv(incompletion_report_file, index=False, encoding="utf-8-sig")
print(f"Incompletion report saved to {incompletion_report_file}")

# Generate the missed surveys report for a specific month/year
target_month = input("Enter the target month/year (yyyy-mm): ").strip()
incomplete_records = merged_completion_matrix[
    merged_completion_matrix[target_month] == "0"
].index.tolist()

missed_surveys = []
for record_id in incomplete_records:
    for data in [data_1, data_2]:
        for date_col, (event, instrument) in date_to_instrument_map.items():
            if date_col in data.columns:
                data[date_col] = pd.to_datetime(data[date_col], errors="coerce")
                filtered_data = data.loc[data["record_id"] == record_id, date_col]
                if not filtered_data.empty:
                    date_value = filtered_data.values[0]
                    if pd.notna(date_value) and pd.Timestamp(date_value).to_period("M") == pd.Period(target_month):
                        survey_link = fetch_survey_link(record_id, event, instrument)
                        missed_surveys.append({
                            "record_id": record_id,
                            "event": event,
                            "instrument": instrument,
                            "survey_link": survey_link
                        })

missed_surveys_df = pd.DataFrame(missed_surveys)

# Add the first name and email columns from REDCap
missed_surveys_df["redcap-name"] = missed_surveys_df["record_id"].apply(fetch_first_name)
missed_surveys_df["email"] = missed_surveys_df["record_id"].apply(fetch_email)

# Merge with contacts.csv and enhance data
contacts_file = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/Contacts/contacts.csv"
enhanced_df = enhance_with_contacts_and_text(missed_surveys_df, contacts_file)

# Save the final output
final_output_path = os.path.join(output_dir, f"{target_month}-followup.csv")
enhanced_df.to_csv(final_output_path, index=False, encoding="utf-8-sig")
print(f"Final enhanced follow-up file saved to {final_output_path}")

# Assuming `enhanced_df` is already defined in the script
# Check if the column 'email_content' exists
if 'email_content' in enhanced_df.columns:
    # Create a new column 'email_content_updated'
    # This column will retain only the first instance of duplicate content
    enhanced_df['email_content_updated'] = enhanced_df['email_content'].where(~enhanced_df['email'].duplicated(), '')
    # Create another column to fix duplicate links in 'email_content_updated'
    def remove_duplicate_links(content):
        if pd.isna(content):
            return content
        lines = content.splitlines()
        unique_lines = []
        seen = set()
        for line in lines:
            if line.startswith("Link for "):
                if line not in seen:
                    seen.add(line)
                    unique_lines.append(line)
            else:
                unique_lines.append(line)
        return "\n".join(unique_lines)
    enhanced_df['email_content_updated_fixed'] = enhanced_df['email_content_updated'].apply(remove_duplicate_links)
    # Drop unnecessary columns
    enhanced_df.drop(columns=['email_content', 'email_content_updated'], inplace=True)
    # Rename the final column
    enhanced_df.rename(columns={'email_content_updated_fixed': 'email_content'}, inplace=True)


# Function to remove duplicate links
def remove_duplicate_links(content):
    if pd.isna(content):
        return content
    lines = content.splitlines()
    unique_lines = []
    seen = set()
    for line in lines:
        if line.startswith("Link for "):
            if line not in seen:
                seen.add(line)
                unique_lines.append(line)
        else:
            unique_lines.append(line)
    return "\n".join(unique_lines)

# Apply the function to both 'text' and 'text-2' columns in the existing enhanced_df
enhanced_df['text'] = enhanced_df['text'].apply(remove_duplicate_links)
enhanced_df['text-2'] = enhanced_df['text-2'].apply(remove_duplicate_links)



final_output_path = os.path.join(output_dir, f"{target_month}-followup.csv")
enhanced_df.to_csv(final_output_path, index=False, encoding="utf-8-sig")
print(f"Final enhanced follow-up file saved to {final_output_path}")


# OpenPhone API URL and API key
url = "https://api.openphone.com/v1/messages"
api_key = "qVwmCaMIT9MeXL3IPVV3mSNhlanX6K7b"  # Replace with your correct OpenPhone API key

# Gmail SMTP server details
smtp_server = 'smtp.gmail.com'
smtp_port = 587
sender_email = 'cablablite@gmail.com'
sender_password = 'uluv nkwa tzsf innx'  # Your App Password here

# Send Email via SMTP
def send_email_via_smtp(to, subject, body):
    """Send an email via Gmail's SMTP server."""
    if pd.isna(body) or not body:
        print(f"Skipping email to {to}: Email content is missing or NaN.")
        return  # Skip sending the email if content is missing or NaN

    if isinstance(body, float):
        body = str(body)  # Convert float to string if it's a float

    message = MIMEMultipart()
    message['From'] = sender_email
    message['To'] = to
    message['Subject'] = subject
    
    msg = MIMEText(body)
    message.attach(msg)

    try:
        with smtplib.SMTP(smtp_server, smtp_port) as server:
            server.starttls()  # Secure the connection
            server.login(sender_email, sender_password)
            text = message.as_string()
            server.sendmail(sender_email, to, text)
            print(f"Email sent to {to}")
    except Exception as e:
        print(f"Failed to send email to {to}. Error: {e}")

# Send Text Message using OpenPhone API
def send_message(content, phone_number):
    """Send a message via OpenPhone API."""
    phone_number = str(phone_number).strip()  # Convert phone number to string and remove any extra spaces
    
    # Remove any unwanted decimal places (if the number is read as a float)
    if '.' in phone_number:
        phone_number = phone_number.split('.')[0]  # Remove the decimal part
    
    # Ensure the phone number starts with a "+" and then the country code "1"
    if not phone_number.startswith('+'):
        phone_number = "+" + phone_number  # Add "+" at the start for E.164 format if missing
    
    # Ensure content is not NaN
    if pd.isna(content):
        content = ""  # Replace NaN with empty string

    # Ensure content is a string (to avoid float or other types causing issues)
    content = str(content)

    # Prepare the data
    data = {
        "content": content,
        "from": "+14849788919",  # Your phone number in E.164 format
        "to": [phone_number]
    }

    # Set up headers with the API key
    headers = {
        'Content-Type': 'application/json',
        'Authorization': api_key  # No "Bearer" prefix
    }

    # Send the POST request
    try:
        response = requests.post(url, json=data, headers=headers)
        response.raise_for_status()  # Raise an exception for HTTP error codes (4xx, 5xx)
        print(f"Text sent successfully to {phone_number}.")
    except requests.exceptions.HTTPError as err:
        print(f"Failed to send text to {phone_number}: {err}")
    except Exception as e:
        print(f"Error sending text to {phone_number}: {e}")

# Process CSV and send emails and texts
def process_csv_and_send_messages():
    """Process the CSV file and send emails and texts based on the reminder choice."""
    reminder = input("Which reminder is this (1 or 2): ").strip()
    
    if reminder not in ['1', '2']:
        print("Invalid choice. Exiting.")
        return

    # Assuming final_output_path is defined earlier in your code
    final_output_path = os.path.join(output_dir, f"{target_month}-followup.csv")
    
    # Read the CSV file
    df = pd.read_csv(final_output_path)

    # Convert phone numbers to string format to avoid float issues
    df['phone_number_1'] = df['phone_number_1'].astype(str)

    # Loop through each row and send emails and/or texts
    for index, row in df.iterrows():
        phone_number_1 = row['phone_number_1']
        email = row['email']
        text_content = row['text']  # Assumes the CSV has a 'text' column
        text_2_content = row['text-2']  # Assumes the CSV has a 'text-2' column
        email_content = row['email_content']

        # Skip rows with invalid phone number or empty content
        if pd.isna(phone_number_1) or (reminder == '2' and pd.isna(email_content)):
            print(f"Skipping row {index} due to missing phone number or content.")
            continue

        # Send Text Message
        if reminder == '1':
            send_message(text_content, phone_number_1)
        elif reminder == '2':
            send_message(text_2_content, phone_number_1)

        # Send Email if reminder 1
        if reminder == '1' and not pd.isna(email) and not pd.isna(email_content):
            send_email_via_smtp(email, "Project LITe: Survey Reminder", email_content)

# Run the function to process CSV and send messages
process_csv_and_send_messages()
