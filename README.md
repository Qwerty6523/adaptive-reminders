# Adaptive Reminders

**A self-maintaining system for Apple Reminders that learns your rhythms instead of making you configure them.**

Every task manager makes you declare "repeat every 7 days" — and then that number is wrong forever, because your real life doesn't run on a fixed cadence. Adaptive Reminders flips it: you just use Reminders normally, and the system *measures* your rhythms from what you actually complete.

## The three ideas

1. **Intervals are learned, not set.** When a recurring item is completed, the next one is scheduled from the *completion date* plus an interval the system re-estimates from your recent completion history (median of recent gaps, protected against one late week permanently distorting it). Recurring items carry their current estimate in the title: `Tp~13`, `Walk Mocha~2`, `Pantoprazole~46`.
2. **Recurring items are promoted by evidence, not configuration.** Do a one-off three or more times on a regular rhythm and the system graduates it into a recurring item on its own. You never fill in a repeat form.
3. **Your working list is a rolling 7-day window.** Future items sleep in their category lists. When an item's due date comes within a week, it moves into your To Do list — as a subtask under a parent reminder for its category — and if you push it beyond a week, it moves back out. To Do never grows past a week, no matter how much the system is tracking behind it.

Supporting detail: the system counts how many times each item's due date gets pushed (`Due Date Changes` in the notes metadata), which turns "things you keep stalling on" into data instead of guilt.

## How it works

**Lists.** One `To Do` list plus seven category ("parent") lists: Shopping, Chores, Family, Personal, Work, Events, Bills. Inside To Do there are seven parent *reminders* with the same names; this week's items live under them as subtasks. (You can rename the categories — just keep the names identical in the lists, the parent reminders, and the `parentLists` array in the scripts.)

**Triggers.** Everything runs off the Reminders app itself, via Shortcuts personal automations:

- **Reminders OPENED →** *Update Due Date Counter* (compares each due date against the last-seen value in its notes, counts changes) and *Update To Do List* (the 7-day two-way mover).
- **Reminders CLOSED →** *RecurranceUpdater*, a chain: `RecurrenceAnaylsis.js` (detect rhythms among completed one-offs, promote them) → *Update Completed Parent* (backfill the `Parent: X` tag onto recently completed reminders) → `MaintainAdaptiveReminders.js` (relearn intervals, create next iterations in the parent lists, log the run).

**Metadata.** Items carry a small header in their notes: `Parent: Shopping**#recurring`, followed by a `----` block with `Last Due Date:` and `Due Date Changes:`. Anything you write in the notes beyond that is yours — it's preserved across iterations.

## Install

You need an iPhone with Shortcuts and the free **Scriptable** app.

1. **Create the lists** above, and the seven same-named parent reminders inside To Do.
2. **Install the Scriptable scripts** (in `scripts/`): create scripts named exactly `MaintainAdaptiveReminders` and `RecurrenceAnaylsis` (yes, the misspelling is load-bearing — the shortcuts call it by that name) and paste in the contents of the matching files. `Due_Date_Analysis.js` is optional (see below).
3. **Add the shortcuts:**
   - [Update To Do List](https://www.icloud.com/shortcuts/df18f3fd6ad54327bc5901ad51aa7bc4)
   - [Update Due Date Counter](https://www.icloud.com/shortcuts/0f81adc14d21474f9aff24a159fae041)
   - [RecurranceUpdater](https://www.icloud.com/shortcuts/340f158186984c8794eb24fb4fd54062)
   - [Update Completed Parent](https://www.icloud.com/shortcuts/7539e04d509c4af78f4cef1e1558f76b)
4. **Create the automations** (personal automations can't be shared, so these three minutes are manual): Shortcuts → Automation → App → Reminders →
   - *Is Opened* → Run Immediately → run Update Due Date Counter, then Update To Do List.
   - *Is Closed* → Run Immediately → run RecurranceUpdater.
5. **Use Reminders normally.** Add items as subtasks of the right parent in To Do with a due date (a home-screen capture shortcut that asks title / category / due date helps). Complete things when you actually do them — completion times are the training data. Give the system a few weeks: items need ~3 completions before the learning kicks in.

## Make it yours

Nothing here is hard-coded to one person's life. The knobs, in the order you'll probably want them:

- **Your categories.** Rename or replace the seven parent lists (add "Health", drop "Events", whatever fits). Change the names in three places so they match exactly: your Reminders lists, the seven parent reminders in To Do, and the `parentLists` array near the top of `MaintainAdaptiveReminders.js` and `RecurrenceAnaylsis.js`. That array is the single source of truth for the scripts.
- **Window length.** 7 days is a choice, not a law. In *Update To Do List*, the window is one date calculation (today + 7 days) — change it to 3 for a tighter list or 14 for a calmer one. Keep it in sync with the resurrection threshold in `MaintainAdaptiveReminders.js` (items overdue by more than the window are rescheduled to tomorrow rather than dropped).
- **How fast things promote.** The Analyzer graduates a one-off after **3 regular completions** within the last year. Edit the thresholds near its pattern-detection section to require more evidence (4–5) if the system promotes things you didn't mean to make permanent.
- **How far back learning looks.** In `MaintainAdaptiveReminders.js`: `LEARNING_WINDOW_DAYS` (400) is how much completion history informs an interval; `ACTIVE_WINDOW_DAYS` (90) is how recent the last completion must be for an item to keep being maintained — raise it if you maintain slow seasonal items.
- **The rhythm itself.** You don't configure intervals at all — but completing items when you actually do them (rather than batch-checking later) is what keeps the learned numbers honest.

## Honest limitations

- **It can fail silently, rarely.** iOS occasionally kills a script mid-run ("could not run script"). The system is designed for this: every step checks before creating, so a missed run just heals on the next open/close — no duplicates. Run logs land in iCloud Drive → Scriptable → Downloads (`MaintainLog.txt`, `NewReminders.txt`).
- **Scriptable is required** for the learning parts and is lightly maintained (last release Sept 2024, works fine on current iOS). The mover and counter are pure Shortcuts.
- **Due_Date_Analysis.js** is a standalone report (postponement patterns, category stats) that reads an exported `ReminderData.txt`. It's a manual extra, not part of the automation; the export tooling isn't included in this kit.
- **Not for shared lists.** The metadata lives in notes and titles; people you share a list with will see the `~N` suffixes.

## Why not just use Todoist's `every!` / Things' "after completion"?

Those anchor the next occurrence to your completion — a good idea this system also uses — but the interval is still a number *you* picked once. Here the interval itself is re-measured from your history, one-offs promote themselves, and it all runs on stock Apple Reminders.

---

*Built and refined through daily use. The scripts in this kit are the current versions, including robust interval learning (median + outlier rejection), calendar-day math, and preservation of your own notes across iterations.*

## Repository layout

- `scripts/MaintainAdaptiveReminders.js` — relearns intervals, creates next iterations, writes `MaintainLog.txt`
- `scripts/RecurrenceAnaylsis.js` — detects rhythms among completed one-offs and promotes them
- `scripts/Due_Date_Analysis.js` — optional standalone postponement/pattern report
- The four shortcuts are distributed via the iCloud links in the Install section (shortcuts can't be committed to git in an installable form).

## License

MIT — see `LICENSE`. Use it, fork it, build on it.
