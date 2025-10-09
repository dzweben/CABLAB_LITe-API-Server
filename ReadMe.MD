# 🧠 Project LITe Survey Automation Server

Welcome to the **Project LITe Survey Automation Server** — a locally automated system developed by **Danny Zweben** to handle survey tracking, delivery, and data syncing for [Project LITe](https://reporter.nih.gov/search/Hi84xz6vkkC3zbsmPU9sHw/project-details/10764006), a 4-year NIH-funded study with over 430 participants.

---

## 🚀 What This Server Does

Participants complete up to 9 surveys per year across multiple time points. Manually tracking and messaging participants would be overwhelming — so this server was built to:

- Automatically update a central Google Sheets tracker from REDCap data  
- Visually flag survey progress with dynamic conditional formatting  
- Send monthly email and text reminders using Gmail, OpenPhone, and REDCap APIs  
- Keep everything in sync — no human input needed

All scripts are **automated on a local drive** and run via scheduled cron jobs.

---

## 📂 Folder Overview

### `FollowupCheck/`
- Pulls REDCap data via API
- Filters and pivots survey completion info
- Updates the shared Google Sheet with the latest data

> This is the data ingestion and syncing engine of the server.

---

### `Conditional Formatting/`
- Applies color-coded conditional formatting rules to the tracker
- Highlights completed or missing entries based on REDCap data
- Works alongside `FollowupCheck` to provide real-time visual status

---

### `FollowupText/` 
- Sends **monthly survey reminders** to participants
- Uses **Gmail, OpenPhone, and REDCap APIs** to automate outreach
- Tailors messages based on who still needs to complete what

> This is the outreach engine of the server.

---

## 🧠 Why It Matters

With 430+ participants and over 30 potential surveys per person across 4 years, this system automates:

- ~3,800+ survey sends per year  
- Ongoing completion tracking  
- Real-time updates to shared logs  
- Survey reminder logic — email & SMS  

What used to take hours… now runs silently.

---

## 🔐 Security & Setup

The files containing API tokens and credentials are **not included in this public GitHub repository** for security reasons. If you need access or help setting things up, feel free to reach out.

- All credentials (`.txt`, `.json`) are stored locally in secure folders
- Automation runs through local cron jobs
- No sensitive data is committed or shared publicly

---

## 👨‍💻 Developer

Built and maintained by **Danny Zweben**  
For questions or setup help: `danny.zweben99@gmail.com`

---

> This isn’t just a script — it’s a local server powering a massive longitudinal study.
