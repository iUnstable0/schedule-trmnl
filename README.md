# schedule-trmnl

A daily schedule screen for [TRMNL X](https://usetrmnl.com)

Connects to any standard `.ics` / iCal feed (Google Calendar, iCloud, Outlook, Canvas, etc.) and merges them into a single timeline.

<img width="2082" height="1566" alt="CleanShot 2026-10-28 at 01 16 43@2x" src="https://github.com/user-attachments/assets/9f761d9c-3e4c-4cce-805c-e537c6246d1a" />

<img width="2088" height="1558" alt="CleanShot 2026-10-28 at 01 17 28@2x" src="https://github.com/user-attachments/assets/98ee2f80-5473-4920-8215-8fd913b20944" />

<img width="2092" height="1564" alt="CleanShot 2026-10-28 at 01 17 54@2x" src="https://github.com/user-attachments/assets/71e06e20-c115-4482-8545-f96c1787772f" />

---

## Quick Setup

`git clone` this repo onto your computer or just download the zip and extract it. doesnt really matter.

then `cd` into the directory and:

### 1. Configure your calendars

Copy the example file:

```bash
cp config.example.json config.json
```

Add your `.ics` calendar URLs into `config.json`:

```json
{
  "timezone": "America/New_York",
  "sources": [
    { "id": "school", "label": "School", "url": "webcal://..." },
    {
      "id": "home",
      "label": "Home",
      "tag": "HOME",
      "busy": false,
      "url": "webcal://..."
    },
    {
      "id": "tasks",
      "label": "Tasks",
      "kind": "due",
      "url": "https://.../feed.ics"
    }
  ]
}
```

- **`timezone`**: The time zone your calendars live in. Used by the local preview; on the device, the plugin's Time zone setting wins.
- **`sources`**: an array of calendars
  - **`id`**: A unique identifier for the calendar.
  - **`label`**: A label for the calendar.
  - **`url`**: The URL of the calendar.
  - **`tag`**: _optional_ A short badge shown next to the title.
  - **`"kind": "due"`**: _optional_ sends events to the **Due today** list instead of the timeline (great for Canvas assignments).
  - **`"busy": false`**: _optional_ Events on this calendar don't count as commitments so the "free for x amount of time" labels won't fill in the gap

Feeds can be iCloud public links, Google Calendar secret iCal links, Canvas calendar feeds, webcal:// urls, etc.

This file is about _what to read_, so it lives on the server. How the screen _looks_ is set on TRMNL instead (step 4): the clock style, the time zone, and how long a gap has to be before it's labelled free. You can still put `"clock"` and `"free_gap_min"` in this file as defaults for the local preview, but a TRMNL setting always wins.

### 2. Preview locally

Test it in your browser with a scrubbable timeline slider:

```bash
bun install
bun run dev
```

Open `http://localhost:8788/preview.html`. You can drag the time slider to preview how the layout responds at different hours of the day. The Data menu switches between a demo day, a busy demo week, and your own calendars.

### 3. Deploy

```bash
bunx vercel link
bunx vercel env add CONFIG --environment production --sensitive --value "$(tr -d '\n' < config.json)"
SECRET=$(openssl rand -hex 16); echo "Your TOKEN: $SECRET"
bunx vercel env add TOKEN --environment production --sensitive --value "$SECRET"
```

Save the printed token for configuring on TRMNL dashboard

Don't share your token!

Then deploy:

```bash
bunx vercel --prod
```

Save the aliased URL. example: https://poop.vercel.app

### 4. Add to TRMNL

1. In TRMNL, go to **Plugins** → **Private Plugin** → **Add new**.
2. Set Strategy to **Polling** (GET) and use this as the polling URL. The parts in curly braces are filled in from the form fields you add in the next step:
   ```
   {{ endpoint }}/api/today?key={{ token }}&tz={{ tz }}&clock={{ clock }}&gap={{ gap }}
   ```
3. Scroll down to **Form Fields**, below the polling settings, and paste the contents of [`form.yml`](form.yml). Click **Save**.

4. Then reload page so the form field config appears.
   Now fill in your Vercel URL (for example `https://schedule-trmnl.vercel.app`), the TOKEN value from step 3 of the deploy, and your preferences, then save.

5. In **Edit Markup** (Full tab), paste the contents of [`markup.liquid`](markup.liquid),save, exit, and press **Refresh Now (optional)**.

---

## Free time

The timeline labels long gaps, for example "2 h 15 min free". A gap only counts as free when it sits between two commitments (meaning an event marked as "busy" unless that entire calendar source was marked as busy: false in config.json)

## Deadlines outside the timeline

The timeline only spans the day's events. A deadline that falls before or after that range, like homework due at 11:59 PM, shows as a small marker with an arrow at the top or bottom edge instead of stretching the timeline.
