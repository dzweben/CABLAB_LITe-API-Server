from googleapiclient.discovery import build
from google.oauth2.service_account import Credentials

# Helper function to compute column index
def column_letter_to_index(column_letter):
    """Convert a column letter (e.g., 'A', 'AA') to a zero-based column index."""
    index = 0
    for char in column_letter:
        index = index * 26 + (ord(char.upper()) - ord("A") + 1)
    return index - 1  # Convert to zero-based index

# Authenticate with Google Sheets API
def authenticate_google_sheets(credentials_file):
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(credentials_file, scopes=scopes)
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    return service

# Apply conditional formatting
def apply_conditional_formatting(service, spreadsheet_id, sheet_id, column_mapping, highlight_color):
    requests = []
    
    for follow_up_col, stsw1_col in column_mapping.items():
        # Compute column indices for Follow up.1
        follow_up_col_index = column_letter_to_index(follow_up_col)
        
        # Define the conditional formatting rule
        rule = {
            "addConditionalFormatRule": {
                "rule": {
                    "ranges": [
                        {
                            "sheetId": sheet_id,
                            "startColumnIndex": follow_up_col_index,
                            "endColumnIndex": follow_up_col_index + 1,
                            "startRowIndex": 10,  # Start from row 11 (zero-based index)
                        }
                    ],
                    "booleanRule": {
                        "condition": {
                            "type": "CUSTOM_FORMULA",
                            "values": [
                                {
                                    # Use VALUE() to handle numbers or strings
                                    "userEnteredValue": f'=VALUE(INDEX(INDIRECT("sts1w1!{stsw1_col}$2:{stsw1_col}"), MATCH(A11, INDIRECT("sts1w1!$A$2:$A"), 0))) = 2'
                                }
                            ],
                        },
                        "format": {
                            "backgroundColor": highlight_color,
                        },
                    },
                },
                "index": 0,  # Add the rule to the top of the list
            }
        }
        requests.append(rule)

    # Send the batch request to apply formatting
    body = {"requests": requests}
    service.spreadsheets().batchUpdate(spreadsheetId=spreadsheet_id, body=body).execute()
    print("Conditional formatting applied successfully!")

# Main function
def main():
    # File paths and IDs
    credentials_file = "/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/Google_API/arcane-boulder-445318-e0-ae3efe15a20e.json"
      # Read Google Sheets spreadsheet ID from a text file for safety
    with open("/Users/dannyzweben/Desktop/CABLAB_Files/STEMA_imports/API_INFO/sessionnotes-googleid.txt", "r") as file:
        spreadsheet_id = file.read().strip()
    sheet_id_follow_up = 1725785302  # GID of Follow up.1
    sheet_id_stsw1 = 353573031  # GID of sts1w1

    # Corrected column mappings
    column_mapping = {
        "P": "B",
        "Q": "C",
        "R": "D",
        "S": "E",
        "T": "F",
        "U": "G",
        "AB": "H",
        "AC": "I",
        "AD": "J",
    }

    # Define highlight color (Green)
    highlight_color = {"red": 91 / 255, "green": 170 / 255, "blue": 104 / 255}

    # Authenticate with Google Sheets
    service = authenticate_google_sheets(credentials_file)

    # Apply conditional formatting rules
    apply_conditional_formatting(service, spreadsheet_id, sheet_id_follow_up, column_mapping, highlight_color)

if __name__ == "__main__":
    main()
