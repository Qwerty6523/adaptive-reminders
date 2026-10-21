// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: magic;
// Recurrence Analyzer Script — REFINED (2026-10-20)
// (Filename kept exactly, including the "Anaylsis" spelling — your shortcuts
// call this script by name.)
//
// What this script does (unchanged in purpose):
// Scans completed reminders in To Do whose notes name a parent list, groups
// them by parent + title, and when a one-off has been completed 3+ times on a
// regular rhythm it promotes it: it creates a recurring "Title~N" reminder in
// the parent list, where N is the learned interval in days.
//
// Refinements vs. the previous version:
// 1. TITLE CASE PRESERVED. The previous version lowercased every title and
//    then Title-Cased it back, which is why your reminders say "Adriana’S"
//    (the \b in the old capitalizeWords matched after the apostrophe) and why
//    acronyms and names lost their real capitalization. The created title now
//    keeps the exact capitalization of your most recent completion; only the
//    grouping KEY is normalized.
// 2. NOTES IN THE SHARED FORMAT. Created reminders now get notes
//    "Parent: <List>**#recurring" — the exact format MaintainAdaptiveReminders
//    reads. Previously this script wrote only "#recurring", which the
//    maintenance script cannot parse for a parent, so promoted items could be
//    invisible to maintenance until another shortcut re-tagged them.
// 3. DUE DATE FROM LAST COMPLETION. The first due date is now
//    last completion + interval (consistent with the maintenance script),
//    not today + interval. All-day flags are set the same way as well.
// 4. DAILY HABITS CAN BE PROMOTED. Detection previously required an average
//    interval of at least 3 days, so genuinely daily items (your ~1 chores)
//    could never qualify. Minimum is now 1 day.
// 5. REGULARITY SCALES WITH THE INTERVAL. The old test used a fixed
//    mean-absolute-deviation cap of 14 days: far too loose for a weekly item
//    (a 7-day item could scatter by two weeks) and too tight, proportionally,
//    for a yearly one. Now regularity is the median absolute deviation from
//    the MEDIAN gap, capped at max(2, 50% of the median). (Re-review patch:
//    measuring deviation from the mean let one outlier gap poison the test
//    permanently; the median-based version is immune to a single bad gap.)
//    The interval itself is the MEDIAN gap, so one late completion doesn't
//    drag it.
// 6. TAGGING CAN'T KILL THE RUN. Marking source reminders "processed" is
//    wrapped per-reminder: if a save() fails on one (the history of this
//    script suggests .tags/.save() has been fragile), the failure is logged
//    and the run continues instead of dying after creating the reminder.
// 7. Calendar-day math throughout (see MaintainAdaptiveReminders header).

const today = new Date();
today.setHours(0, 0, 0, 0);

const RECENT_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const recentThreshold = new Date(today.getTime() - RECENT_DAYS * DAY_MS);

// NOTE: keep this list identical in all three scripts.
const parentLists = ["Shopping", "Chores", "Family", "Personal", "Work", "Events", "Bills"];

// ---------- Shared helpers (identical logic in all three scripts) ----------

function normalizeTitle(title) {
  return title.trim().toLowerCase().replace(/\s+/g, " ").replace(/~(\d+)$/, "").trim();
}

function baseTitleOf(title) {
  return title.replace(/~(\d+)$/, "").trim();
}

function intervalOf(title) {
  const m = title.match(/~(\d+)$/);
  return m ? parseInt(m[1]) : null;
}

function getParentListFromNotes(notes) {
  if (!notes) return null;
  const match = notes.match(/parent:\s*([a-z]+)/i);
  if (!match) return null;
  return parentLists.find(list => list.toLowerCase() === match[1].toLowerCase()) || null;
}

function dayNumber(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getFormattedDate() {
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------- Analysis ----------

async function analyzeRecurrence() {
  const calendars = await Calendar.forReminders();
  // Case-insensitive matching, same as MaintainAdaptiveReminders — a list
  // renamed "To do" or "shopping" should not silently disable one script
  // while the other keeps working.
  const toDoList = calendars.find(c => c.title.toLowerCase() === "to do");

  const targetCalendars = {};
  parentLists.forEach(list => {
    const cal = calendars.find(c => c.title.toLowerCase() === list.toLowerCase());
    if (cal) targetCalendars[list] = cal;
    else console.log(`Warning: Calendar '${list}' not found`);
  });

  if (!toDoList) {
    console.log("Error: 'To Do' list not found");
    Script.complete();
    return;
  }

  // 1. Load ALL reminders from "To Do" (completed history + live objects)
  console.log("Loading all reminders from 'To Do' list...");
  const allToDoReminders = await Reminder.all([toDoList]);

  // 2. Load incomplete reminders from everywhere (for duplicate check)
  console.log("Loading incomplete reminders from all calendars...");
  let allIncompleteTitles = [];
  for (const cal of calendars) {
    try {
      const inc = await Reminder.allIncomplete([cal]);
      allIncompleteTitles.push(...inc.map(r => normalizeTitle(r.title)));
    } catch (e) {
      console.log(`Error loading incomplete from ${cal.title}: ${e}`);
    }
  }

  // 3. Find completed subtasks that look like one-offs but repeat.
  //    Candidates: completed, no native recurrence rule, not already tagged
  //    recurring/processed, notes name a valid parent list.
  const potentialSubtasks = allToDoReminders.filter(r => {
    if (!r.isCompleted || !r.completionDate) return false;
    // RE-REVIEW PATCH: a title that already carries ~N is already recurring —
    // it is MaintainAdaptiveReminders' job, not a promotion candidate. (The
    // original had no such guard; because this script runs BEFORE Maintain in
    // the close chain, it could create the next iteration itself, with an
    // unclamped interval, and tag the sources "processed". The duplicate
    // check below masked this whenever an open copy already existed.)
    if (intervalOf(r.title) !== null) return false;
    if (r.recurrenceRules?.length) return false;
    let tags = [];
    try { tags = Array.isArray(r.tags) ? r.tags : []; } catch (e) { tags = []; }
    if (tags.includes("recurring") || tags.includes("#recurring") || tags.includes("processed")) return false;
    return getParentListFromNotes(r.notes) !== null;
  });

  // 4. Group by parent list + normalized title.
  //    The DISPLAY title keeps the capitalization of the most recent copy.
  const groups = {};
  potentialSubtasks.forEach(r => {
    const parentList = getParentListFromNotes(r.notes);
    const key = `${parentList}:${normalizeTitle(r.title)}`;
    if (!groups[key]) {
      groups[key] = { parentList, title: baseTitleOf(r.title), latestCompletion: r.completionDate, dates: [], reminders: [] };
    }
    if (r.completionDate >= groups[key].latestCompletion) {
      groups[key].latestCompletion = r.completionDate;
      groups[key].title = baseTitleOf(r.title);
    }
    groups[key].dates.push(r.completionDate);
    groups[key].reminders.push(r); // keep live objects for "processed" tagging
  });

  // 5. Detect recurring patterns: 3+ completions in the last year, on a
  //    rhythm that is regular RELATIVE to its own interval.
  const candidates = [];
  for (const g of Object.values(groups)) {
    const days = [...new Set(g.dates.filter(d => d >= recentThreshold).map(dayNumber))].sort((a, b) => a - b);
    if (days.length < 3) continue;

    const intervals = [];
    for (let i = 1; i < days.length; i++) intervals.push(days[i] - days[i - 1]);

    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const med = median(intervals);
    // RE-REVIEW PATCH #2 (found by executing this script against synthetic
    // data): regularity is the median absolute deviation FROM THE MEDIAN.
    // The previous version measured mean deviation from the mean, which a
    // single outlier gap poisons: a weekly rhythm with intervals [7, 7, 26]
    // scored MAD 8.4 against a cap of 6.7 and could NEVER be promoted, no
    // matter how many clean weeks followed. With median-based MAD the same
    // pattern scores 0 (two of three gaps sit exactly on the median) and
    // promotes at ~7, while genuinely scattered gaps (e.g. [9, 1, 27],
    // median deviation 8 vs cap 4.5) are still rejected.
    const mad = median(intervals.map(d => Math.abs(d - med)));
    const interval = Math.max(1, Math.round(med));

    if (mad <= Math.max(2, med * 0.5)) {
      candidates.push({ parentList: g.parentList, title: g.title, interval, lastDay: days[days.length - 1], group: g });
      console.log(`Pattern → ${g.parentList}: ${g.title} (~${interval} days, avg ${avg.toFixed(1)}, median ${med}, MAD ${mad})`);
    }
  }

  // 6. Create the recurring reminder in the parent list, then tag the
  //    source reminders as "processed".
  const created = [];
  for (const cand of candidates) {
    const { parentList, title, interval } = cand;
    const newTitle = `${title}~${interval}`;
    const normNewTitle = normalizeTitle(newTitle);

    if (allIncompleteTitles.includes(normNewTitle)) {
      console.log(`Already exists → ${parentList}: ${newTitle}`);
      continue;
    }
    if (!targetCalendars[parentList]) continue;

    const r = new Reminder();
    r.title = newTitle;
    r.calendar = targetCalendars[parentList];
    r.notes = `Parent: ${parentList}**#recurring`;
    const lastDate = new Date(today);
    lastDate.setDate(lastDate.getDate() - (dayNumber(today) - cand.lastDay));
    r.dueDate = addDays(lastDate, interval);
    // RE-REVIEW PATCH: a regular-but-stale pattern (3 completions long ago)
    // would otherwise be born weeks or months overdue and get swept straight
    // into To Do by Update To Do List. Clamp the first due date to tomorrow,
    // mirroring Maintain's resurrection rule.
    if (dayNumber(r.dueDate) < dayNumber(today)) {
      r.dueDate = addDays(today, 1);
      console.log(`Note: first due date for '${newTitle}' would have been in the past; set to tomorrow.`);
    }
    r.dueDateIncludesTime = false;
    r.isAllDay = true;
    await r.save();
    allIncompleteTitles.push(normNewTitle); // guard duplicates within this run

    // Tag ALL original completed subtasks as processed (live objects).
    // A tagging failure must not fail the run — log it and move on.
    let tagFailures = 0;
    for (const old of cand.group.reminders) {
      try {
        if (!Array.isArray(old.tags)) old.tags = [];
        if (!old.tags.includes("processed")) {
          old.tags.push("processed");
          await old.save();
        }
      } catch (e) {
        tagFailures++;
        console.log(`Could not tag '${old.title}' as processed: ${e}`);
      }
    }
    if (tagFailures > 0) console.log(`Note: ${tagFailures} source reminder(s) for '${title}' could not be tagged and may be re-examined next run.`);

    created.push(`${parentList}: ${newTitle}`);
    console.log(`Created → ${parentList}: ${newTitle}`);
  }

  // 7. Write results. Wrapped: by this point the reminders are already
  // created — a file error must not kill the run before Script.complete().
  try {
    const fm = FileManager.iCloud();
    const dir = fm.joinPath(fm.documentsDirectory(), "Downloads");
    if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
    const path = fm.joinPath(dir, "NewReminders.txt");

    if (created.length > 0) {
      const text = `${getFormattedDate()}\n${created.join("\n")}`;
      fm.writeString(path, text);
      console.log("Success! New recurring reminders:\n" + text);
    } else {
      fm.writeString(path, `${getFormattedDate()}\nNo new recurring tasks detected.`);
      console.log("No new recurring tasks created today.");
    }
  } catch (e) {
    console.log(`Could not write NewReminders.txt: ${e}`);
  }

  // Give iCloud time to sync
  await new Promise(r => Timer.schedule(4000, false, r));
}

await analyzeRecurrence();
Script.complete();
