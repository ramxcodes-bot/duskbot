# Proactive routines

Dusk keeps an eye on the person's day with one ordinary routine,
"Keep an eye on my day". It is never made without a yes: on a personal install
or Cloud that can reach connected apps, Dusk posts one card in its chat with
**Turn it on** and **Not now**. Turn it on makes the routine, daily at 08:00 in
the person's time zone (the computer's clock, or the owner's zone on a Cloud).
Not now is kept and the card never comes back. An install that already made the
routine, or whose bot already has a briefing routine, is never asked, and a
watch it made earlier on a 15-minute schedule is left as it is. It is built from
four upgrades every routine can use, plus the helper models for the inbox.
The bot that is proactive is the one `proactiveOwner` names
(`server/host/proactive-owner.ts`): the place's Dusk, shown in the sidebar or
not, and the main Chief only where there is no Dusk. A Team Cloud member's
Dusk is never the one. There is no second bot and no separate watcher: the
routine engine (`server/routines.ts`) runs it like any other routine, on the
desktop, headless and on a Cloud.

## Who owns it

- **A new install.** Its first bot is Dusk, which is also its Chief. The
  routine, the brief, the add-a-key card and the intro's line about the day are
  Dusk's.
- **An install that had a Chief before Dusk.** The Chief stays the Chief.
  The first time the server starts with Dusk there, the Chief's "Keep an eye
  on my day" becomes Dusk's. It is the same routine, moved, so everything
  the person set stays: on or paused, the instructions they edited, the checks'
  cursors and seen ids, and the day's run count. The brief's chat becomes
  Dusk's own conversation, and its next card says again what it does. Cards
  already posted stay where they were.
- **The handover is safe to repeat.** It waits while a run of the routine is
  queued or working. `watch.json` records which bot each briefing routine was
  handed to, so it happens once: a routine the person later puts back on the
  Chief stays there. A restart between the steps finishes them at the next
  start, and a computer frozen by a move to My Cloud hands nothing over.
- **One on at a time.** When a briefing routine lands on Dusk, handed over
  or arrived with it in a move, it is the one. Every other briefing routine is
  paused, never deleted, so the inbox is never read twice and a paused routine
  stays paused.
- **Hidden from the sidebar.** Dusk keeps working: the brief is posted to its
  chat, and the notification and the first open of the day open that chat.

## What the person sees

- **The brief.** One ordinary chat message a day from Dusk, in a fixed chat
  of Dusk's, edited in place, written with no AI. It exists only once it has
  something for the person (something that needs them, an important email or a
  meeting today); an empty brief is never posted. It opens on the first open of
  the day and after three hours away. Any other moment, it never takes the
  screen from the chat in use. No title or date: the first one ever says once
  what it does and that the person can tell Dusk to stop or change it. Then:
  1. "Quick heads-up, N things need you:" and a short list (six at most, then
     "and N more"): emails waiting on a reply, failed or missed routines,
     meetings that clash, an app that can't be read ("Couldn't read Gmail:
     Reconnect Gmail in Connected apps."), a signed-out AI, a usage limit, a
     question a bot is waiting on ("Juno asked you: ..."). A line that opens a
     chat links it, and an email links its Gmail thread. With none of these,
     one line: "All good, nothing needs you right now.";
  2. one line naming today's meetings and their times;
  3. "Also worth a look:" a few other important emails, routine results (with
     the page a run published) and the night's ideas.
  Mail, invites, questions and ideas are untrusted: each piece is escaped, so it
  can never become a link, image, heading or math. Briefs posted as cards
  before this stay in the chat as they were.
- **Meeting prep**: a card in the same chat when a meeting with other people is
  within four hours.
- **The 10-minute reminder**: a card posted by the server, with no AI.
- One notification per update that adds something that needs the person.

Pausing or deleting the routine in the bot panel is the off switch: with it off
there is no brief at all. Its row says
"reads and drafts only" and "checked … , nothing new".

## The four routine upgrades, and the helper models

1. **Checks before the model.** A routine can name `checks`: `calendar` (the
   next 36 hours), `mail` (new inbox mail since the cursor) and `runs` (other
   routines' finished runs). They are plain code over one connected-apps
   session per tick, as the default account of each app, and only for apps the
   bot's own app switches let it read. Nothing new starts no turn and leaves no
   run, only "checked at". Reminders, clashes and Your day need no AI. Email
   triage and meeting prep go to **one** batched run, each item in a records
   block. The cursor moves only once that run's answer is kept, and items are
   deduplicated by id. A failed or misshapen read is never "nothing new": it
   keeps the cursor, backs off and shows its trouble.
2. **Nothing to report, structured.** A routine that delivers to the brief
   answers with one small JSON object: `{"quiet": true}`, or important emails
   and preps by item id. The server reads it. An answer it cannot read fails the
   run and is never posted, and its items wait for the next check. Every other
   routine keeps the NOTHING NEW convention in `server/automation-reports.ts`.
3. **Read-and-draft runs** (`access: "read-and-draft"`), in
   `server/read-and-draft.ts`. Everything is allow-only:
   - the run runs at Ask, and the server refuses every request in it outright,
     never as a card;
   - its dusk bot routes are conversation reads, its own results, the
     engine's hooks and the connected-apps relay;
   - through the relay it reads Gmail and Google Calendar, and may write one
     draft per thread, replying to that thread's sender, in a thread its checks
     handed it;
   - Gmail's and Calendar's answers reach it as records;
   - no web search, browser, computer, phone or other tools; no memory, recent
     work, team notes or skills in its prompt; nothing captured into memory;
   - its conversation stays out of recall, recent work, `list_threads` and Chief
     notices.

   The model work needs an engine whose every tool use reaches dusk bot's
   answerer (Claude today). On any other engine the watch prepares no meeting,
   says so in the brief, and still does what needs no AI.
5. **Helper models sort the inbox** (`server/host/inbox-triage.ts`). With a
   decision model set up (Settings → Decision and extraction: the person's own
   Cloudflare Workers AI or Jev key, or Cloud's included one), new mail is
   sorted with no AI turn, on every engine: Clairic reads each email (sender,
   the ask, any deadline or amount, whether it waits on a reply, what kind of
   mail it is) and Clef decides important, needs a reply, or skip, hearing the
   senders the person recently dismissed. Only important and needs-a-reply
   mail becomes rows; the why is built in plain code from what was read. The
   helper models can't act, so no fence is needed. If they fail, the mail
   waits for the next check. A full AI turn runs only for meeting prep, or when
   the person presses Draft a reply. Without any helper model, the AI run sorts
   mail as above, on Claude only.
4. **Deliver to the brief** (`deliver: "brief"`): results become brief rows,
   not chat lines of their own.

## Script-only routines

A script check (`probe.kind: "script"`) with `post: true` runs its command on
schedule and posts what it prints as the bot's reply. No AI turn runs.

- **Posts.** Any output, as written.
- **Quiet.** Empty output, or a last line of `{"wakeAgent": false}`.
- **Fails.** A non-zero exit or a timeout. The routine's `timeoutMinutes` sets
  the limit; without it the limit is 60 seconds.
- **Fence.** The script runs read-only by default.
- **`access: "full"`.** Runs it outside the fence, as the server's user, so it can
  write files. A bot cannot grant this alone: the person approves it on a card.
  The card also says the script posts without the AI.

## Reliability, for every routine with checks

- **Overlap.** While a run works, checks still run (reminders stay on time), but
  hand the AI nothing until it ends.
- **Catch-up.** However late the computer wakes, missed checks merge into one,
  never a missed run.
- **Backoff.** After a failed run the next waits 15 minutes, doubled each time,
  at most 4 hours, with jitter. The owner hears once per failure streak.
- **Busy.** A run of checked items waits for a busy bot without a notice and
  never fails for being busy.
- **Throttle.** At most 24 AI runs in any 24 hours; then items wait.
- **Boot.** The first checks wait two minutes after start.
- **Wake.** Only the checks' next on-time job (a reminder, a prep) keeps the
  desktop awake or wakes a sleeping Cloud. Plain mail checks run whenever the
  machine is awake anyway.
- Every other routine keeps main's rules: one quick automatic retry, usage
  limits waited out, one notice per owner cause.

## State and privacy

- `routine-checks.json`: per routine, cursors, judged ids, meetings prepped and
  reminded, and the items a run holds. Ids and times only.
- `brief.json`: the brief's home chat and today's message, presence, the zone of
  record (from the person's device, so a Cloud is not stuck on UTC), the
  important rows by id, and recent dismissals with the sender's address. The
  senders and subjects it shows are read back from Gmail by id after a restart.
- `watch.json`: that the routine was made (or one was already there), so it is
  never made or suggested again; the one suggestion card posted; Not now, so it
  is never asked again; and the bot each briefing routine was handed to.
- A card or brief message the server built carries `serverCard`. A bot can't
  edit it, and it replays into a turn only as records. Dismiss, on today's brief
  card from before the brief was a message, works only for the owner or an
  admin, checks thread ownership before reading a widget, and starts no turn.
  Recent dismissals go into the next triage as records.
- A hosted team workspace or Team Cloud gets no watch and no brief. Presence is
  recorded for the owner only.
- An install that can't reach connected apps gets no watch, and so no brief,
  until it can. It checks once a minute, since a Cloud's access arrives after
  start. A scripted test install without the fake connected-apps service
  behaves as before.
- Routines carry `checks`, `access` and `deliver` through Cloud moves and team
  backups. The watch moves to My Cloud with Dusk. A move carries Dusk
  when it has a routine the person set up, paused or changed, even if nobody
  has opened Dusk; the watch exactly as the server made it does not count.
  On My Cloud the arrived watch pauses My Cloud's own. The move freeze pauses the watch like any routine, so two
  homes never watch the same inbox. Dusk never moves into a team.

## Not in v1

- More than one account per app.
- Phone push when the app is closed (there is no caller of the push relay yet).
- Quiet hours.
- A sweep of old run conversations.
- A run against a real Google account: the Composio slugs and answer shapes
  follow its documentation and the fixtures in `server/testing/fixtures/`.
