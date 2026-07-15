import json
import os

from google.oauth2 import service_account
from googleapiclient.discovery import build

SHEET_ID = "1_pjZJw6Y3Z6GibdmuQOwzaAazWme-HD26MiBCR16Rfs"

TABS = [
    ("Summary", "summary"),
    ("D2C & Auto POD", "d2c-auto"),
    ("Govt + Telco", "govt-telco"),
    ("CDIT+BFSI POD", "cdit-bfsi"),
    ("FMCG North POD", "fmcg-north"),
    ("FMCG - South POD", "fmcg-south"),
    ("FMCG West POD", "fmcg-west"),
    ("Gaming POD", "gaming"),
]


def main():
    creds_path = os.environ["GCP_CREDS_PATH"]
    creds = service_account.Credentials.from_service_account_file(
        creds_path,
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
    )
    service = build("sheets", "v4", credentials=creds)
    values_api = service.spreadsheets().values()

    os.makedirs("data", exist_ok=True)
    for sheet_name, slug in TABS:
        result = values_api.get(spreadsheetId=SHEET_ID, range=sheet_name).execute()
        values = result.get("values", [])
        with open(f"data/{slug}.json", "w") as f:
            json.dump({"values": values}, f)
        print(f"wrote data/{slug}.json ({len(values)} rows)")


if __name__ == "__main__":
    main()
