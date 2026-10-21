// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: gray; icon-glyph: magic;
// Adaptive Reminder Maintenance Script — REFINED (2026-10-20)
//
// What this script does (unchanged in purpose):
// Maintains recurring reminders created by RecurrenceAnaylsis.js. Scans completed
// reminders in the To Do list whose title ends in ~N (e.g. "Buy Milk~7"), groups
// them by base title + parent, relearns the interval from actual completions,
// and creates the next reminder in the parent list.
//
// Refinements vs. the previous version:
// 1. CALENDAR-DAY MATH. Intervals are computed between whole local days, not
//    raw timestamps, so a completion at 9am vs 10:36pm no longer makes the
//    same real-world gap measure as two different intervals, and DST changes
//    can't shift a due date by a day.
// 2. ROBUST INTERVAL LEARNING. Uses the MEDIAN of recent intervals instead of
//    the mean, drops outlier intervals (more than 2x or less than 1/3 of the
//    current interval — e.g. one batch of very late completions), and clamps
//    any single relearn to between 1/2x and 2x of the current interval. One
//    bad week can no longer permanently distort ~N.
// 3. SAME-DAY DEDUP. Multiple completions of the same item on one day count
//    once (they used to inject 0-day intervals that dragged the average down).
// 4. LONGER LEARNING WINDOW, SAME ACTIVITY RULE. Completion history is read
//    back 400 days so slower items (~46 meds, ~90 items) can actually relearn,
//    but a group is only maintained if its last completion is within 90 days,
//    so items you deliberately stopped don't resurrect.
// 5. NO MORE SILENT DEATH. Previously, if the computed due date was more than
//    7 days in the past the item was silently dropped and never came back.
//    Now it is recreated due tomorrow and the resurrection is reported.
// 6. FORGIVING PARENT PARSING. The parent tag is found anywhere in the notes
//    (not only at the very start, not only when followed by "**"), matching
//    the other two scripts. Groups skipped for a missing/invalid parent are
//    listed in the summary instead of only in the console.
// 7. NOTES PRESERVED. Any user content in the completed reminder's notes
//    (after the "Parent: X**#recurring" header) is carried into the new
//    reminder instead of being discarded.
// 8. FASTER + SAFER DUPLICATE CHECK. Each parent list is loaded once per run
//    (not once per group), and the duplicate check also matches an incomplete
//    reminder with the same base title WITHOUT a ~N suffix.
// 9. RUN SUMMARY. Created / resurrected / skipped items are written to
//    Downloads/MaintainLog.txt (same folder the other scripts use) and logged,
//    so you can see what a run did without opening the console.

// Initialize today’s date
const today = new Date();
today.setHours(0, 0, 0, 0);

// Configuration: Define all parent reminder lists
// NOTE: keep this list identical in all three scripts.
const parentLists = ["Shopping", "Chores", "Family", "Personal", "Work", "Events", "Bills"];
let targetLists = {};

// Time constraints
const DAY_MS = 24 * 60 * 60 * 1000;
const LEARNING_WINDOW_DAYS = 400; // how far back completions inform the interval
const ACTIVE_WINDOW_DAYS = 90;    // last completion must be this recent to maintain
const learningThreshold = new Date(today.getTime() - LEARNING_WINDOW_DAYS * DAY_MS);
const activeThreshold = new Date(today.getTime() - ACTIVE_WINDOW_DAYS * DAY_MS);

// ---------- Shared helpers (identical logic in all three scripts) ----------

// Strip the ~N suffix and normalize spacing/case for COMPARISON ONLY.
// Never store this normalized form as a title — it destroys real capitalization.
function normalizeTitle(title) {
  return title.trim().toLowerCase().replace(/\s+/g, " ").replace(/~(\d+)$/, "").trim();
}

// The reminder's title without its ~N suffix, original capitalization kept.
function baseTitleOf(title) {
  return title.replace(/~(\d+)$/, "").trim();
}

function intervalOf(title) {
  const m = title.match(/~(\d+)$/);
  return m ? parseInt(m[1]) : null;
}

// Find the parent list named in a reminder's notes, in any of the formats the
// family's scripts/shortcuts have written over time:
//   "Parent: Shopping**#recurring"   "Parent: Shopping** extra text"
//   "... Parent: Shopping ..."       (tag not at the start)
// Returns the canonical list name, or null.
function getParentListFromNotes(notes) {
  if (!notes) return null;
  const match = notes.match(/parent:\s*([a-z]+)/i);
  if (!match) return null;
  return parentLists.find(list => list.toLowerCase() === match[1].toLowerCase()) || null;
}

// Whole local days since the epoch, for DST-proof day differences.
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

// User-written note content worth keeping: the completed reminder's notes with
// the "Parent: X**" header and the #recurring marker removed.
// RE-REVIEW PATCH (2026-10-20 evening): the Update Due Date Counter metadata
// block ("----", "Last Due Date:", "Due Date Changes:") is ALSO stripped.
// It is per-instance bookkeeping — if it were carried over, the new reminder
// would inherit the old instance's "Last Due Date", and the counter shortcut
// would count the new due date as a spurious extra change on its first pass.
function preservedNotes(notes) {
  if (!notes) return "";
  return notes
    .replace(/parent:\s*[a-z]+\s*\*\*/i, "")
    .replace(/#recurring/g, "")
    .replace(/^-+\s*$/gm, "")
    .replace(/^Last Due Date:.*$/gm, "")
    .replace(/^Due Date Changes:.*$/gm, "")
    .trim();
}

// ---------- Reminder list loading ----------

async function initializeReminderLists() {
  console.log("Initializing reminder lists...");
  try {
    let reminderLists = await Calendar.forReminders();
    parentLists.forEach(list => {
      let reminderList = reminderLists.find(c => c.title.toLowerCase() === list.toLowerCase());
      if (reminderList) {
        targetLists[list] = reminderList;
        console.log(`Found reminder list: ${list}`);
      } else {
        console.log(`Warning: Reminder list '${list}' not found in Reminders app`);
      }
    });
    let toDoList = reminderLists.find(c => c.title.toLowerCase() === "to do");
    if (toDoList) {
      targetLists["To Do"] = toDoList;
      console.log("Found reminder list: To Do");
    } else {
      console.log("Error: To Do reminder list not found");
    }
  } catch (e) {
    console.log(`Error loading reminder lists: ${e}`);
  }
}

// ---------- Maintenance ----------

async function maintainRecurringReminders() {
  console.log("Starting maintenance of recurring reminders...");
  const summary = { created: [], resurrected: [], skipped: [] };

  let toDoList = targetLists["To Do"];
  if (!toDoList) {
    console.log("Skipping maintenance: To Do list not found");
    return summary;
  }

  let toDoReminders = await Reminder.all([toDoList]);
  console.log(`Loaded ${toDoReminders.length} reminders from To Do list`);

  // Completed recurring reminders within the learning window
  let completedRecurring = toDoReminders.filter(r =>
    r.isCompleted &&
    intervalOf(r.title) !== null &&
    r.completionDate &&
    r.completionDate >= learningThreshold
  );
  console.log(`Found ${completedRecurring.length} completed recurring reminders in To Do list (past ${LEARNING_WINDOW_DAYS} days)`);

  // Group by parent list + base title
  let groups = {};
  let unparented = [];
  for (let reminder of completedRecurring) {
    const baseTitle = baseTitleOf(reminder.title);
    const parentListName = getParentListFromNotes(reminder.notes);
    if (!parentListName) {
      unparented.push(reminder.title);
      continue;
    }
    const key = `${parentListName}:${normalizeTitle(baseTitle)}`;
    groups[key] = groups[key] || { parentListName, baseTitle, reminders: [] };
    groups[key].reminders.push(reminder);
  }
  if (unparented.length > 0) {
    summary.skipped.push(`${unparented.length} completed reminder(s) had no readable parent tag and were skipped: ${[...new Set(unparented)].join(", ")}`);
  }

  // Cache parent-list reminders: each list is loaded at most once per run
  const parentCache = {};
  async function incompleteBasesIn(listName) {
    if (!(listName in parentCache)) {
      const list = targetLists[listName];
      parentCache[listName] = list ? await Reminder.allIncomplete([list]) : [];
    }
    return parentCache[listName].map(r => normalizeTitle(r.title));
  }
  const toDoIncompleteBases = toDoReminders.filter(r => !r.isCompleted).map(r => normalizeTitle(r.title));

  for (let group of Object.values(groups)) {
    const { parentListName, baseTitle, reminders } = group;
    if (!baseTitle) {
      summary.skipped.push(`(empty base title) (${parentListName}): title was only a ~N suffix`);
      continue;
    }
    const parentList = targetLists[parentListName];
    if (!parentList) {
      summary.skipped.push(`${baseTitle}: parent list '${parentListName}' not found`);
      continue;
    }

    // Unique completion DAYS, oldest first (same-day completions count once)
    const daySet = new Set(reminders.map(r => dayNumber(r.completionDate)));
    const days = [...daySet].sort((a, b) => a - b);
    const lastCompletionDay = days[days.length - 1];
    const lastDate = new Date(today);
    lastDate.setDate(lastDate.getDate() - (dayNumber(today) - lastCompletionDay));

    if (lastDate < activeThreshold) {
      summary.skipped.push(`${baseTitle} (${parentListName}): last completed ${lastDate.toDateString()}, outside the ${ACTIVE_WINDOW_DAYS}-day activity window`);
      continue;
    }

    // Current interval: from the most recently completed reminder's title
    const latestReminder = [...reminders].sort((a, b) => a.completionDate - b.completionDate)[reminders.length - 1];
    const currentInterval = intervalOf(latestReminder.title);

    // Intervals between completion days
    let intervals = [];
    for (let i = 1; i < days.length; i++) intervals.push(days[i] - days[i - 1]);

    // Drop outlier intervals (one very late or batch completion shouldn't
    // relearn the rhythm), if enough intervals remain afterwards
    if (currentInterval && intervals.length > 1) {
      const sane = intervals.filter(d => d <= 2 * currentInterval && d >= Math.max(1, currentInterval / 3));
      if (sane.length > 0) intervals = sane;
    }

    // Relearn: median of the last 3 intervals, clamped to 1/2x–2x of current
    let newInterval;
    if (intervals.length > 0) {
      newInterval = Math.round(median(intervals.slice(-3)));
      if (currentInterval) {
        const lo = Math.max(1, Math.floor(currentInterval / 2));
        const hi = Math.max(lo, Math.ceil(currentInterval * 2));
        newInterval = Math.min(hi, Math.max(lo, newInterval));
      }
    } else {
      newInterval = currentInterval; // a single completion teaches nothing new
    }
    newInterval = Math.max(1, newInterval);
    console.log(`'${baseTitle}' (${parentListName}): intervals [${intervals.join(", ")}], current ~${currentInterval}, new ~${newInterval}`);

    // Duplicate check: To Do or the parent list, with or without a ~N suffix
    const base = normalizeTitle(baseTitle);
    if (toDoIncompleteBases.includes(base)) {
      summary.skipped.push(`${baseTitle} (${parentListName}): already open in To Do`);
      continue;
    }
    const parentIncompleteBases = await incompleteBasesIn(parentListName);
    if (parentIncompleteBases.includes(base)) {
      summary.skipped.push(`${baseTitle} (${parentListName}): already open in ${parentListName}`);
      continue;
    }

    // Due date: last completion + new interval (calendar days, DST-safe)
    let dueDate = addDays(lastDate, newInterval);
    let resurrected = false;
    if (dayNumber(dueDate) < dayNumber(today) - 7) {
      // Previously this item silently died here. Resurrect it due tomorrow
      // instead, and say so in the summary.
      dueDate = addDays(today, 1);
      resurrected = true;
    }

    // Create the next reminder in the parent list, preserving user notes
    let reminder = new Reminder();
    reminder.title = `${baseTitle}~${newInterval}`;
    reminder.dueDate = dueDate;
    reminder.dueDateIncludesTime = false;
    reminder.isAllDay = true;
    reminder.calendar = parentList;
    const kept = preservedNotes(latestReminder.notes);
    reminder.notes = `Parent: ${parentListName}**#recurring` + (kept ? `\n${kept}` : "");
    await reminder.save();

    const entry = `${baseTitle}~${newInterval} in ${parentListName}, due ${dueDate.toDateString()}`;
    (resurrected ? summary.resurrected : summary.created).push(entry);
    console.log(`${resurrected ? "Resurrected" : "Created"} next reminder: ${entry}`);
  }

  return summary;
}

// ---------- Main ----------

function writeSummary(summary) {
  const lines = [];
  // Local date, not toISOString() (UTC) — an evening run would otherwise
  // stamp the log with tomorrow's date.
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  lines.push(`Adaptive Reminders maintenance — ${stamp}`);
  lines.push(`Created: ${summary.created.length}`);
  summary.created.forEach(e => lines.push(`  - ${e}`));
  lines.push(`Resurrected (would previously have been dropped): ${summary.resurrected.length}`);
  summary.resurrected.forEach(e => lines.push(`  - ${e}`));
  lines.push(`Skipped: ${summary.skipped.length}`);
  summary.skipped.forEach(e => lines.push(`  - ${e}`));
  const text = lines.join("\n");
  console.log(text);
  try {
    const fm = FileManager.iCloud();
    const dir = fm.joinPath(fm.documentsDirectory(), "Downloads");
    if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
    fm.writeString(fm.joinPath(dir, "MaintainLog.txt"), text);
  } catch (e) {
    console.log(`Could not write summary file: ${e}`);
  }
}

async function runMaintenance() {
  console.log("Starting adaptive reminders maintenance script...");
  await initializeReminderLists();
  if (targetLists["To Do"]) {
    const summary = await maintainRecurringReminders();
    writeSummary(summary);
  } else {
    console.log("Cannot proceed: To Do list not found");
  }
  console.log("Maintenance complete.");
  Script.complete();
}

runMaintenance();
