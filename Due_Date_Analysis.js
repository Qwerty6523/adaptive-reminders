// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-purple; icon-glyph: magic;
// Script to analyze completed reminders from ReminderData.txt with recurrence intervals and patterns
// — REFINED (2026-10-20)
//
// Refinements vs. the previous version:
// 1. INPUT IS DOWNLOADED BEFORE IT IS READ, and a missing input file now
//    produces a short "no data" report instead of crashing the script.
//    (The old version called downloadFileFromiCloud on the OUTPUT file
//    after writing it, which did nothing useful, and never ensured the
//    input had downloaded.)
// 2. RECURRENCE COMES FROM THE TITLE. The ~N interval lives in reminder
//    TITLES ("Milk~7"), but the old parser looked for it in Tags, so
//    recurrence almost always came back "None" — which silently broke the
//    recurring vs. non-recurring statistics and Recommendation 1. The
//    title is now checked first, tags second.
// 3. REAL CATEGORIES. Tasks are categorized by their actual Parent from the
//    notes (Shopping / Chores / Family / Personal / Work / Events / Bills)
//    instead of keyword guessing, which misfiled your real data — "meds"
//    counted your own Pantoprazole as Family, "litter" items were Family
//    instead of Chores/Shopping, Lunch Orders were Personal instead of
//    Family — and invented a "Household" category that isn't one of your
//    lists. Keyword guessing remains only as a fallback when no parent is
//    recorded, and its results are labelled "Other" unless they land on one
//    of the seven real lists.
// 4. ROBUST PARENT PARSING. Parent is extracted with a regex anywhere in the
//    notes, so markdown "**" in ordinary note text can no longer corrupt it,
//    and a blank "Parent: **" cleanly yields no parent.
// 5. NULL-SAFE RECOMMENDATIONS. Tasks whose metadata has no parseable due
//    date no longer crash the shopping-cluster recommendation.

const fm = FileManager.iCloud();
const baseDir = fm.documentsDirectory();
const downloadsDir = fm.joinPath(baseDir, "Downloads");
const inputFile = fm.joinPath(downloadsDir, "ReminderData.txt");
const outputFile = fm.joinPath(downloadsDir, "ReminderAnalysis.txt");

// NOTE: keep this list identical in all three scripts.
const parentLists = ["Shopping", "Chores", "Family", "Personal", "Work", "Events", "Bills"];

// Ensure Downloads directory exists
if (!fm.fileExists(downloadsDir)) {
  fm.createDirectory(downloadsDir, true);
}

// Download the input BEFORE reading it; bail out cleanly if it isn't there.
await fm.downloadFileFromiCloud(inputFile);
const inputMissing = !fm.fileExists(inputFile);
if (inputMissing) {
  const msg = "Reminder Analysis: no input found.\n" +
    `Expected ReminderData.txt at ${inputFile}\n` +
    "Run the shortcut that exports ReminderData.txt first.";
  console.log(msg);
  fm.writeString(outputFile, msg);
}

if (!inputMissing) {

// Function to parse the recurrence interval: ~N in the TITLE first
// (that's where the system stores it), then in tags as a fallback.
function parseRecurrenceInterval(title, tags) {
  const titleMatch = title && title.match(/~(\d+)$/);
  let interval = titleMatch ? parseInt(titleMatch[1]) : null;
  if (interval === null && tags) {
    const tag = tags.split(",").map(t => t.trim()).find(t => /^~\d+$/.test(t));
    if (tag) interval = parseInt(tag.replace("~", ""));
  }
  if (interval !== null) {
    return interval === 7 ? "Weekly" :
           interval === 14 ? "Biweekly" :
           interval === 21 ? "ThreeWeekly" :
           interval === 30 ? "Monthly" : `Custom (${interval}d)`;
  }
  return tags && tags.includes("Recurring") ? "Recurring" : "None";
}

// Function to parse date and normalize to midnight UTC
function parseDate(dateStr) {
  if (!dateStr) return null;
  const months = {
    "Jan": 0, "Feb": 1, "Mar": 2, "Apr": 3, "May": 4, "Jun": 5,
    "Jul": 6, "Aug": 7, "Sep": 8, "Oct": 9, "Nov": 10, "Dec": 11
  };
  const parts = dateStr.trim().split(/[\s,]+/);
  if (parts.length >= 3) {
    const month = months[parts[0].slice(0, 3)];
    const day = parseInt(parts[1]);
    const year = parseInt(parts[2]);
    if (month !== undefined && day && year) {
      return new Date(Date.UTC(year, month, day));
    }
  }
  return null;
}

// Fallback categorization by keyword — ONLY used when a reminder has no
// recorded parent. Returns one of the seven real lists when it is confident,
// otherwise "Other" (the old version's keyword rules are kept, but they now
// map onto the real lists).
function categorizeTask(title, tags, parent) {
  if (parent && parentLists.includes(parent)) return parent;
  const lowerTitle = (title || "").toLowerCase();
  if (lowerTitle.includes("clean") || lowerTitle.includes("laundry") || lowerTitle.includes("fridge")) {
    return "Chores";
  } else if (lowerTitle.includes("cat") || lowerTitle.includes("litter") || lowerTitle.includes("meds") || lowerTitle.includes("birthday")) {
    return "Family";
  } else if (lowerTitle.includes("read") || lowerTitle.includes("haircut")) {
    return "Personal";
  } else if (lowerTitle.includes("lunch")) {
    return "Family";
  } else if (lowerTitle.includes("paper towels") || lowerTitle.includes("bread") || lowerTitle.includes("milk") || lowerTitle.includes("chicken") || lowerTitle.includes("beef") || lowerTitle.includes("water bottles")) {
    return "Shopping";
  } else if (lowerTitle.includes("work truck") || lowerTitle.includes("excise tax")) {
    return "Work";
  }
  return "Other";
}

// Function to parse metadata from reminder notes
function parseMetadata(notes) {
  const metadata = {
    recurrence: "None",
    creationDate: null,
    dueDate: null,
    completionDate: null,
    dueDateChanges: 0,
    parent: null,
    note: null
  };

  if (!notes) return metadata;

  // Parent: "Parent: <word>" anywhere in the notes; canonicalized (or null
  // for a blank/unknown parent, e.g. "Parent: **").
  const parentMatch = notes.match(/parent:\s*([a-z]+)/i);
  if (parentMatch) {
    metadata.parent = parentLists.find(l => l.toLowerCase() === parentMatch[1].toLowerCase()) || null;
  }

  const lines = notes.split("\n");
  let mainNote = [];
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith("Last Due Date:")) {
      metadata.dueDate = parseDate(line.replace("Last Due Date:", "").trim());
    } else if (line.startsWith("Due Date Changes:")) {
      metadata.dueDateChanges = parseInt(line.replace("Due Date Changes:", "").trim()) || 0;
    } else if (line !== "----" && !/^parent:\s*[a-z]*\s*\*\*/i.test(line)) {
      mainNote.push(line);
    }
  }
  metadata.note = mainNote.join("\n").replace(/#recurring/g, "").trim() || null;

  return metadata;
}

// Function to determine if a reminder was early, late, or on time.
// Both dates are UTC-midnight values from parseDate, so this is a pure
// calendar-day comparison.
function getCompletionStatus(dueDate, completionDate) {
  if (!dueDate || !completionDate) return "Unknown";
  const due = new Date(dueDate);
  const completed = new Date(completionDate);
  if (completed < due) return "Early";
  if (completed > due) return "Late";
  return "OnTime";
}

// Read and parse ReminderData.txt
let remindersData = fm.readString(inputFile).split("Title: ");
remindersData.shift(); // Remove the empty first element

let analysis = {
  postponed: {}, // title -> {count, avgChanges, details}
  early: {},     // title -> {count, avgDaysEarly, details}
  late: {},      // title -> {count, avgDaysLate, details}
  allReminders: [] // For pattern analysis
};

for (let reminderBlock of remindersData) {
  const lines = reminderBlock.trim().split("\n");
  const title = lines[0].trim();
  let tags = lines.find(line => line.startsWith("Tags:"))?.replace("Tags:", "").trim() || "";
  let notes = "";
  let creationDate = null;
  let completionDate = null;
  let inNotesSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("Creation Date:")) {
      creationDate = parseDate(line.replace("Creation Date:", "").trim());
    } else if (line.startsWith("Completion Date:")) {
      completionDate = parseDate(line.replace("Completion Date:", "").trim());
    } else if (line.startsWith("Notes:")) {
      inNotesSection = true;
      notes = line.replace("Notes:", "").trim();
    } else if (inNotesSection) {
      notes += "\n" + line.trim();
    }
  }

  if (!completionDate) continue; // Skip if no completion date

  const metadata = parseMetadata(notes);
  metadata.completionDate = completionDate;
  metadata.recurrence = parseRecurrenceInterval(title, tags);

  const category = categorizeTask(title, tags, metadata.parent);
  const status = getCompletionStatus(metadata.dueDate, metadata.completionDate);

  // Store for pattern analysis
  analysis.allReminders.push({
    title: title,
    category: category,
    dueDate: metadata.dueDate,
    completionDate: metadata.completionDate,
    dueDateChanges: metadata.dueDateChanges,
    recurrence: metadata.recurrence,
    status: status
  });

  // Postponed analysis
  if (metadata.dueDateChanges > 0) {
    if (!analysis.postponed[title]) analysis.postponed[title] = { count: 0, totalChanges: 0, details: [] };
    analysis.postponed[title].count += 1;
    analysis.postponed[title].totalChanges += metadata.dueDateChanges;
    analysis.postponed[title].details.push({
      dueDate: metadata.dueDate,
      changes: metadata.dueDateChanges,
      recurrence: metadata.recurrence,
      parent: metadata.parent,
      note: metadata.note
    });
  }

  // Early/Late analysis
  if (status === "Early" && metadata.dueDate) {
    const daysEarly = (metadata.dueDate - metadata.completionDate) / (1000 * 60 * 60 * 24);
    if (!analysis.early[title]) analysis.early[title] = { count: 0, totalDays: 0, details: [] };
    analysis.early[title].count += 1;
    analysis.early[title].totalDays += daysEarly;
    analysis.early[title].details.push({
      dueDate: metadata.dueDate,
      completionDate: metadata.completionDate,
      daysEarly: daysEarly,
      recurrence: metadata.recurrence,
      parent: metadata.parent,
      note: metadata.note
    });
  } else if (status === "Late" && metadata.dueDate) {
    const daysLate = (metadata.completionDate - metadata.dueDate) / (1000 * 60 * 60 * 24);
    if (!analysis.late[title]) analysis.late[title] = { count: 0, totalDays: 0, details: [] };
    analysis.late[title].count += 1;
    analysis.late[title].totalDays += daysLate;
    analysis.late[title].details.push({
      dueDate: metadata.dueDate,
      completionDate: metadata.completionDate,
      daysLate: daysLate,
      recurrence: metadata.recurrence,
      parent: metadata.parent,
      note: metadata.note
    });
  }
}

// Function to identify busy periods by clustering due dates
function findBusyPeriods(reminders) {
  const dateCounts = {};
  for (const reminder of reminders) {
    if (reminder.dueDate) {
      const dateStr = reminder.dueDate.toISOString().split("T")[0];
      dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1;
    }
  }

  const busyThreshold = 5; // Consider a day "busy" if 5+ tasks are due
  const busyPeriods = [];
  for (const date in dateCounts) {
    if (dateCounts[date] >= busyThreshold) {
      busyPeriods.push({ date: date, count: dateCounts[date] });
    }
  }
  return busyPeriods.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Function to analyze patterns by category and recurrence
function analyzePatterns(reminders) {
  const patterns = {
    categories: {},
    recurrence: { recurring: { late: 0, early: 0, postponed: 0, total: 0 }, nonRecurring: { late: 0, early: 0, postponed: 0, total: 0 } }
  };

  // Categories are your real lists (plus "Other" for unparented items)
  [...parentLists, "Other"].forEach(category => {
    patterns.categories[category] = { postponed: 0, early: 0, late: 0, total: 0 };
  });

  for (const reminder of reminders) {
    const category = reminder.category;
    if (!patterns.categories[category]) patterns.categories[category] = { postponed: 0, early: 0, late: 0, total: 0 };
    const isRecurring = reminder.recurrence !== "None";
    const group = isRecurring ? patterns.recurrence.recurring : patterns.recurrence.nonRecurring;

    patterns.categories[category].total += 1;
    group.total += 1;

    if (reminder.dueDateChanges > 0) {
      patterns.categories[category].postponed += 1;
      group.postponed += 1;
    }
    if (reminder.status === "Early") {
      patterns.categories[category].early += 1;
      group.early += 1;
    } else if (reminder.status === "Late") {
      patterns.categories[category].late += 1;
      group.late += 1;
    }
  }

  return patterns;
}

// Generate report with clear labels and demarcation
let report = "==================================================\n";
report += "                Reminder Analysis Report          \n";
report += "==================================================\n";
report += `Generated: ${new Date().toISOString()}\n\n`;

// Section 1: Postponed Reminders
report += "--------------------------------------------------\n";
report += "SECTION 1: Postponed Reminders\n";
report += "--------------------------------------------------\n";
report += "Tasks with due date changes (rescheduled at least once).\n\n";

for (let title in analysis.postponed) {
  const data = analysis.postponed[title];
  if (data.count > 0) {
    const avgChanges = (data.totalChanges / data.count).toFixed(2);
    report += `Task: ${title}\n`;
    report += `  Instances: ${data.count}, Avg Due Date Changes: ${avgChanges}, Recurrence: ${data.details[0].recurrence}\n`;
    for (let detail of data.details) {
      report += `    - Due: ${detail.dueDate?.toISOString().split("T")[0] || "N/A"}, Changes: ${detail.changes}, Recurrence: ${detail.recurrence}, Parent: ${detail.parent || "N/A"}, Note: ${detail.note || "N/A"}\n`;
    }
    report += "\n";
  }
}

// Section 2: Early Completions
report += "--------------------------------------------------\n";
report += "SECTION 2: Completed Early Reminders\n";
report += "--------------------------------------------------\n";
report += "Tasks completed before their due date.\n\n";

for (let title in analysis.early) {
  const data = analysis.early[title];
  if (data.count > 0) {
    const avgDays = (data.totalDays / data.count).toFixed(2);
    report += `Task: ${title}\n`;
    report += `  Instances: ${data.count}, Avg Days Early: ${avgDays}, Recurrence: ${data.details[0].recurrence}\n`;
    for (let detail of data.details) {
      report += `    - Due: ${detail.dueDate?.toISOString().split("T")[0] || "N/A"}, Completed: ${detail.completionDate?.toISOString().split("T")[0] || "N/A"}, Recurrence: ${detail.recurrence}, Parent: ${detail.parent || "N/A"}, Note: ${detail.note || "N/A"}\n`;
    }
    report += "\n";
  }
}

// Section 3: Late Completions
report += "--------------------------------------------------\n";
report += "SECTION 3: Completed Late Reminders\n";
report += "--------------------------------------------------\n";
report += "Tasks completed after their due date.\n\n";

for (let title in analysis.late) {
  const data = analysis.late[title];
  if (data.count > 0) {
    const avgDays = (data.totalDays / data.count).toFixed(2);
    report += `Task: ${title}\n`;
    report += `  Instances: ${data.count}, Avg Days Late: ${avgDays}, Recurrence: ${data.details[0].recurrence}\n`;
    for (let detail of data.details) {
      report += `    - Due: ${detail.dueDate?.toISOString().split("T")[0] || "N/A"}, Completed: ${detail.completionDate?.toISOString().split("T")[0] || "N/A"}, Recurrence: ${detail.recurrence}, Parent: ${detail.parent || "N/A"}, Note: ${detail.note || "N/A"}\n`;
    }
    report += "\n";
  }
}

// Section 4: Key Patterns and Insights
report += "--------------------------------------------------\n";
report += "SECTION 4: Key Patterns and Insights\n";
report += "--------------------------------------------------\n";
report += "Analyzing trends in task completion habits.\n\n";

// Perform pattern analysis
const patterns = analyzePatterns(analysis.allReminders);
const busyPeriods = findBusyPeriods(analysis.allReminders);

// 4.1: Postponement Trends
report += "4.1: Postponement Trends\n";
report += "------------------\n";
report += "Identifies tasks frequently rescheduled by category and recurrence.\n\n";

let topPostponed = Object.keys(analysis.postponed)
  .map(title => ({ title, count: analysis.postponed[title].count, avgChanges: (analysis.postponed[title].totalChanges / analysis.postponed[title].count).toFixed(2) }))
  .sort((a, b) => b.count - a.count || b.avgChanges - a.avgChanges)
  .slice(0, 3);

report += "Top Postponed Tasks:\n";
for (const task of topPostponed) {
  report += `- ${task.title}: ${task.count} instances, Avg Changes: ${task.avgChanges}\n`;
}
report += "\n";

report += "Postponements by Category:\n";
for (const category in patterns.categories) {
  const data = patterns.categories[category];
  if (data.total > 0) {
    const postponeRate = ((data.postponed / data.total) * 100).toFixed(1);
    report += `- ${category}: ${data.postponed} postponed out of ${data.total} tasks (${postponeRate}%)\n`;
  }
}
report += "\n";

// 4.2: Completion Habits (Early vs. Late)
report += "4.2: Completion Habits (Early vs. Late)\n";
report += "------------------\n";
report += "Compares early and late completions by category and recurrence.\n\n";

report += "By Category:\n";
for (const category in patterns.categories) {
  const data = patterns.categories[category];
  if (data.total > 0) {
    const earlyRate = ((data.early / data.total) * 100).toFixed(1);
    const lateRate = ((data.late / data.total) * 100).toFixed(1);
    report += `- ${category}: Early: ${data.early} (${earlyRate}%), Late: ${data.late} (${lateRate}%)\n`;
  }
}
report += "\n";

report += "By Recurrence:\n";
const recurring = patterns.recurrence.recurring;
const nonRecurring = patterns.recurrence.nonRecurring;
const recurringEarlyRate = recurring.total > 0 ? ((recurring.early / recurring.total) * 100).toFixed(1) : 0;
const recurringLateRate = recurring.total > 0 ? ((recurring.late / recurring.total) * 100).toFixed(1) : 0;
const nonRecurringEarlyRate = nonRecurring.total > 0 ? ((nonRecurring.early / nonRecurring.total) * 100).toFixed(1) : 0;
const nonRecurringLateRate = nonRecurring.total > 0 ? ((nonRecurring.late / nonRecurring.total) * 100).toFixed(1) : 0;

report += `- Recurring: Early: ${recurring.early} (${recurringEarlyRate}%), Late: ${recurring.late} (${recurringLateRate}%)\n`;
report += `- Non-Recurring: Early: ${nonRecurring.early} (${nonRecurringEarlyRate}%), Late: ${nonRecurring.late} (${nonRecurringLateRate}%)\n`;
report += "\n";

// 4.3: Busy Periods
report += "4.3: Busy Periods\n";
report += "------------------\n";
report += "Days with 5 or more tasks due, indicating high workload.\n\n";

if (busyPeriods.length > 0) {
  for (const period of busyPeriods) {
    report += `- ${period.date}: ${period.count} tasks due\n`;
  }
} else {
  report += "No busy periods detected (less than 5 tasks due on any day).\n";
}
report += "\n";

// 4.4: Recommendations
report += "4.4: Recommendations\n";
report += "------------------\n";
report += "Actionable steps to improve task management based on patterns.\n\n";

// Recommendation 1: Adjust Recurrence Intervals
let recurringLateTasks = Object.keys(analysis.late)
  .filter(title => analysis.late[title].details[0].recurrence !== "None" && analysis.late[title].details[0].recurrence !== "Recurring")
  .map(title => ({ title, avgDaysLate: (analysis.late[title].totalDays / analysis.late[title].count).toFixed(2) }))
  .filter(task => parseFloat(task.avgDaysLate) > 5);

if (recurringLateTasks.length > 0) {
  report += "Adjust Recurrence Intervals:\n";
  report += "- Recurring tasks like the following are often significantly late, suggesting their intervals may be too tight:\n";
  for (const task of recurringLateTasks) {
    report += `  - ${task.title}: Avg ${task.avgDaysLate} days late. Consider extending the interval (e.g., from ~7 to ~10).\n`;
  }
} else {
  report += "Adjust Recurrence Intervals:\n";
  report += "- No recurring tasks are significantly late (over 5 days on average).\n";
}
report += "\n";

// Recommendation 2: Batch Shopping Trips
let shoppingLateTasks = Object.keys(analysis.late)
  .filter(title => categorizeTask(title, "", analysis.late[title].details[0].parent) === "Shopping")
  .map(title => ({ title, dueDate: analysis.late[title].details[0].dueDate }))
  .filter(task => task.dueDate)
  .sort((a, b) => a.dueDate - b.dueDate);

if (shoppingLateTasks.length > 1) {
  let shoppingCluster = shoppingLateTasks[0].dueDate.toISOString().split("T")[0];
  report += "Batch Shopping Trips:\n";
  report += `- Shopping tasks due around ${shoppingCluster} (e.g., ${shoppingLateTasks[0].title}, ${shoppingLateTasks[1].title}) were delayed together. Schedule a fixed shopping day (e.g., every Thursday) and set reminders a day earlier to avoid delays.\n`;
} else {
  report += "Batch Shopping Trips:\n";
  report += "- No significant clustering of late shopping tasks detected.\n";
}
report += "\n";

// Recommendation 3: Prioritize Personal Goals
let personalPostponed = Object.keys(analysis.postponed)
  .filter(title => categorizeTask(title, "", analysis.postponed[title].details[0].parent) === "Personal")
  .map(title => ({ title, count: analysis.postponed[title].count }))
  .sort((a, b) => b.count - a.count);

if (personalPostponed.length > 0) {
  report += "Prioritize Personal Goals:\n";
  report += `- Personal tasks like ${personalPostponed[0].title} (${personalPostponed[0].count} postponements) are frequently delayed. Set a biweekly goal and tie it to a recurring task (e.g., after cleaning) to create consistency.\n`;
} else {
  report += "Prioritize Personal Goals:\n";
  report += "- No personal tasks with frequent postponements detected.\n";
}
report += "\n";

// Recommendation 4: Leverage Early Completion Habits
let earlyWorkTasks = Object.keys(analysis.early)
  .filter(title => categorizeTask(title, "", analysis.early[title].details[0].parent) === "Work")
  .map(title => ({ title, avgDaysEarly: (analysis.early[title].totalDays / analysis.early[title].count).toFixed(2) }));

if (earlyWorkTasks.length > 0) {
  report += "Leverage Early Completion Habits:\n";
  report += `- Work tasks like ${earlyWorkTasks[0].title} (avg ${earlyWorkTasks[0].avgDaysEarly} days early) are often completed ahead of schedule. Use this strength by setting due dates a few days earlier for other high-priority tasks to create a buffer.\n`;
} else {
  report += "Leverage Early Completion Habits:\n";
  report += "- No work tasks completed early detected.\n";
}

report += "\n--------------------------------------------------\n";
report += "END OF REPORT\n";
report += "--------------------------------------------------\n";

// Save report to file
fm.writeString(outputFile, report);

// Show notification
let notification = new Notification();
notification.title = "Reminder Analysis Complete";
notification.body = "Report saved to iCloud Drive > Scriptable > Downloads > ReminderAnalysis.txt";
await notification.schedule();

// Log completion
console.log("Analysis complete. Report saved to " + outputFile);

} // end if (!inputMissing)
Script.complete();
