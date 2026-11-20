const SETTINGS = window.APP_SETTINGS;
let currentSemester = localStorage.getItem("vaertsplan_active_semester") || SETTINGS.defaultSemester;

let state = {
    semester: currentSemester,
    sourceName: "Ny plan",
    lastSyncedAt: null,
    rules: null,
    teachers: [],
    shifts: [],
    activities: [],
    acknowledgedFindings: []
};

let baseFileText = null;
let hasLocalChanges = false;
let selectedActivityTeachers = new Set();
let editingActivityId = null;

window.teacherOverviewMode = "semester";
window.semesterSnapshots = { efteraar: null, foraar: null };

function getStorageKey(sem) {
    return `vaertsplan_v8_${sem}`;
}

function getEffectiveRules() {
    const base = SETTINGS.semesters[currentSemester].rules;
    return { ...base, ...(state.rules || {}) };
}

function getJsonFilename() {
    const p = SETTINGS.semesters[currentSemester].defaultJsonPath || `${currentSemester}.json`;
    return p.split("/").pop();
}

function setStatusBadge(text, tooltip = "") {
    const badge = document.getElementById("data-source-badge");
    if (!badge) return;
    badge.textContent = text;
    badge.title = tooltip || text;
}

// --- NORMALISERING & KOMPRIMERING AF AKTIVITETER ---
function normalizeActivities(activities, rules) {
    return (activities || []).map((act, idx) => {
        const type = act.type || "school_trip";
        const isTrip = type === "school_trip";
        const isEvent = type === "event_host";
        const wkndRate = isTrip ? rules.tripHostHours : rules.weekendHours;
        const calcHours = (w, d, e) => w * wkndRate + d * rules.weekdayHours + e * rules.weekdayHours;

        if (Array.isArray(act.credits)) {
            const existingMap = new Map(act.credits.map(c => [c.teacher, c]));
            const teacherIds = [...new Set([
                ...(Array.isArray(act.teachers) ? act.teachers : []),
                ...act.credits.map(c => c.teacher)
            ])].filter(Boolean);

            const credits = teacherIds.map(tId => {
                const c = existingMap.get(tId) || {};
                const w = c.tripWeekendHosts !== undefined ? Number(c.tripWeekendHosts) : (isTrip ? 1 : 0);
                const d = c.tripDayHosts !== undefined ? Number(c.tripDayHosts) : (isTrip ? 1 : 0);
                const e = c.eventHosts !== undefined ? Number(c.eventHosts) : (isEvent ? 1 : 0);
                const hrs = c.hours !== undefined ? Number(c.hours) : calcHours(w, d, e);
                return { teacher: tId, tripWeekendHosts: w, tripDayHosts: d, eventHosts: e, hours: hrs };
            });

            return {
                id: act.id || (Date.now() + idx),
                type,
                title: act.title || "Skolerejse",
                start: act.start,
                end: act.end || act.start,
                bufferDays: act.bufferDays !== undefined ? Number(act.bufferDays) : rules.defaultTripBufferDays,
                calendarLocked: Boolean(act.calendarLocked),
                noSchoolHosts: Boolean(act.noSchoolHosts),
                credits
            };
        }

        const shared = (act.credits && typeof act.credits === "object") ? act.credits : {};
        const defWknd = shared.tripWeekendHosts !== undefined ? Number(shared.tripWeekendHosts) : (isTrip ? 1 : 0);
        const defDay = shared.tripDayHosts !== undefined ? Number(shared.tripDayHosts) : (isTrip ? 1 : 0);
        const defEvt = shared.eventHosts !== undefined ? Number(shared.eventHosts) : (isEvent ? 1 : 0);
        const overrides = shared.overrides || {};

        const teacherIds = [...new Set([
            ...(Array.isArray(act.teachers) ? act.teachers : []),
            ...Object.keys(overrides)
        ])].filter(Boolean);

        const credits = teacherIds.map(tId => {
            const ov = overrides[tId] || {};
            const w = ov.tripWeekendHosts !== undefined ? Number(ov.tripWeekendHosts) : defWknd;
            const d = ov.tripDayHosts !== undefined ? Number(ov.tripDayHosts) : defDay;
            const e = ov.eventHosts !== undefined ? Number(ov.eventHosts) : defEvt;
            const hrs = ov.hours !== undefined ? Number(ov.hours) : calcHours(w, d, e);
            return {
                teacher: tId,
                tripWeekendHosts: w,
                tripDayHosts: d,
                eventHosts: e,
                hours: hrs
            };
        });

        return {
            id: act.id || (Date.now() + idx),
            type,
            title: act.title || "Skolerejse",
            start: act.start,
            end: act.end || act.start,
            bufferDays: act.bufferDays !== undefined ? Number(act.bufferDays) : rules.defaultTripBufferDays,
            calendarLocked: Boolean(act.calendarLocked),
            noSchoolHosts: Boolean(act.noSchoolHosts),
            credits
        };
    });
}

window.compactActivitiesForJson = function(activities, rules) {
    return (activities || []).map(act => {
        const list = Array.isArray(act.credits) ? act.credits : [];
        const teachers = list.map(c => c.teacher);

        const baseCredit = list[0] || {
            tripWeekendHosts: act.type === "school_trip" ? 1 : 0,
            tripDayHosts: act.type === "school_trip" ? 1 : 0,
            eventHosts: 0,
            hours: act.type === "school_trip"
                ? (rules.tripHostHours + rules.weekdayHours)
                : (act.type === "event_host" ? rules.weekdayHours : 0)
        };

        const creditsObj = {
            tripWeekendHosts: baseCredit.tripWeekendHosts,
            tripDayHosts: baseCredit.tripDayHosts,
            eventHosts: baseCredit.eventHosts,
            hours: baseCredit.hours
        };

        const overrides = {};
        list.forEach(c => {
            if (
                c.tripWeekendHosts !== baseCredit.tripWeekendHosts ||
                c.tripDayHosts !== baseCredit.tripDayHosts ||
                c.eventHosts !== baseCredit.eventHosts ||
                c.hours !== baseCredit.hours
            ) {
                overrides[c.teacher] = {
                    tripWeekendHosts: c.tripWeekendHosts,
                    tripDayHosts: c.tripDayHosts,
                    eventHosts: c.eventHosts,
                    hours: c.hours
                };
            }
        });

        if (Object.keys(overrides).length > 0) {
            creditsObj.overrides = overrides;
        }

        return {
            type: act.type,
            title: act.title,
            start: act.start,
            end: act.end,
            bufferDays: act.bufferDays,
            calendarLocked: Boolean(act.calendarLocked),
            noSchoolHosts: Boolean(act.noSchoolHosts),
            teachers,
            credits: creditsObj
        };
    });
};

// --- FLYT REJSEDELTAGERE FRA REGNEARKETS SKOLEKOLONNE TIL REJSEVÆRTER ---
function reconcileActivityTripSlots(targetState = state) {
    const lockFromSheet = SETTINGS.csvMapping?.lockSheetAssignments !== false;
    (targetState.shifts || []).forEach(s => {
        const noSchoolActs = (targetState.activities || []).filter(a =>
            a.type === "school_trip" && a.noSchoolHosts && s.date >= a.start && s.date < a.end
        );
        if (noSchoolActs.length === 0) return;

        const participants = new Set(noSchoolActs.flatMap(a => (a.credits || []).map(c => c.teacher)));
        const existingTripIds = new Set((s.tripSlots || []).map(ts => ts.teacherId));
        if (!Array.isArray(s.tripSlots)) s.tripSlots = [];

        (s.assigned || []).forEach(tId => {
            if (tId && participants.has(tId) && !existingTripIds.has(tId)) {
                s.tripSlots.push({
                    teacherId: tId,
                    activityId: noSchoolActs[0].id,
                    isWeekendCredit: s.isWeekend,
                    locked: lockFromSheet,
                    fromSheet: true,
                    isAutoDraft: false
                });
                existingTripIds.add(tId);
            }
        });

        s.reqHosts = 0;
        s.assigned = [];
        s.locked = [];
        s.fromSheet = [];
        s.isAutoDraft = [];
    });
}

// --- UDTRÆK & PÅFØRING AF LÅSTE SKOLE- OG REJSEVAGTER ---
function extractLockedShifts(shifts) {
    const lockedShifts = {};
    (shifts || []).forEach(s => {
        if (!Array.isArray(s.locked) || !s.locked.some(Boolean)) return;
        const row = s.assigned.map((id, idx) => (s.locked[idx] && id ? id : null));
        while (row.length > 0 && row[row.length - 1] === null) {
            row.pop();
        }
        if (row.length > 0) {
            lockedShifts[s.date] = row;
        }
    });
    return lockedShifts;
}

function extractLockedTripSlots(shifts) {
    const lockedTripSlots = {};
    (shifts || []).forEach(s => {
        const lockedList = (s.tripSlots || []).filter(ts => ts.locked && ts.teacherId);
        if (lockedList.length > 0) {
            lockedTripSlots[s.date] = lockedList.map(ts => ({
                teacherId: ts.teacherId,
                isWeekendCredit: Boolean(ts.isWeekendCredit)
            }));
        }
    });
    return lockedTripSlots;
}

function applyLockedShiftsOverlay(shifts, lockedShifts, lockedTripSlots = null, activitiesList = state.activities) {
    if (lockedShifts && typeof lockedShifts === "object") {
        shifts.forEach(s => {
            const lockedRow = lockedShifts[s.date];
            if (!Array.isArray(lockedRow)) return;

            const neededLen = Math.max(s.reqHosts, lockedRow.length);
            s.reqHosts = neededLen;
            if (!Array.isArray(s.assigned)) s.assigned = Array(neededLen).fill(null);
            if (!Array.isArray(s.locked)) s.locked = Array(neededLen).fill(false);
            if (!Array.isArray(s.isAutoDraft)) s.isAutoDraft = Array(neededLen).fill(false);

            while (s.assigned.length < neededLen) s.assigned.push(null);
            while (s.locked.length < neededLen) s.locked.push(false);
            while (s.isAutoDraft.length < neededLen) s.isAutoDraft.push(false);

            lockedRow.forEach((teacherId, idx) => {
                if (teacherId) {
                    s.assigned[idx] = teacherId;
                    s.locked[idx] = true;
                    s.isAutoDraft[idx] = false;
                }
            });
        });
    }

    if (lockedTripSlots && typeof lockedTripSlots === "object") {
        shifts.forEach(s => {
            const list = lockedTripSlots[s.date];
            if (!Array.isArray(list)) return;
            const matchingAct = (activitiesList || []).find(a => s.date >= a.start && s.date <= a.end);
            const existingIds = new Set((s.tripSlots || []).map(ts => ts.teacherId));
            if (!Array.isArray(s.tripSlots)) s.tripSlots = [];

            list.forEach(item => {
                if (item.teacherId && !existingIds.has(item.teacherId)) {
                    s.tripSlots.push({
                        teacherId: item.teacherId,
                        activityId: matchingAct ? matchingAct.id : null,
                        isWeekendCredit: Boolean(item.isWeekendCredit),
                        locked: true,
                        isAutoDraft: false
                    });
                }
            });
        });
    }
}

window.buildExportPayload = function(currentState, rules) {
    const payload = {
        semester: currentSemester,
        activities: window.compactActivitiesForJson(currentState.activities, rules),
        lockedShifts: extractLockedShifts(currentState.shifts),
        lockedTripSlots: extractLockedTripSlots(currentState.shifts)
    };
    if (Array.isArray(currentState.acknowledgedFindings) && currentState.acknowledgedFindings.length > 0) {
        payload.acknowledgedFindings = currentState.acknowledgedFindings;
    }
    if (currentState.rules) {
        payload.rules = currentState.rules;
    }
    return payload;
};

// --- INITIALISERING ---
async function initApp() {
    const semSelect = document.getElementById("semester-select");
    if (semSelect) semSelect.value = currentSemester;

    const rawSaved = localStorage.getItem(getStorageKey(currentSemester));
    const parsedWrapper = rawSaved ? JSON.parse(rawSaved) : null;
    const savedState = parsedWrapper ? (parsedWrapper.state || parsedWrapper) : null;
    const savedBaseText = parsedWrapper?.baseFileText || null;
    const savedDirty = parsedWrapper ? Boolean(parsedWrapper.dirty ?? true) : false;

    const jsonPath = SETTINGS.semesters[currentSemester].defaultJsonPath;
    const shortPath = jsonPath ? jsonPath.replace("./", "") : "";
    let diskFileText = null;
    let diskOverlay = null;

    if (jsonPath) {
        try {
            const bustUrl = jsonPath + (jsonPath.includes("?") ? "&" : "?") + "t=" + Date.now();
            const res = await fetch(bustUrl);
            if (res.ok) {
                diskFileText = (await res.text()).trim();
                diskOverlay = JSON.parse(diskFileText);
            }
        } catch {}
    }

    const fileChangedOnDisk = diskFileText !== null && savedBaseText !== diskFileText;

    if (diskOverlay && (!savedState || !savedDirty || fileChangedOnDisk)) {
        const baseRules = { ...SETTINGS.semesters[currentSemester].rules, ...(diskOverlay.rules || {}) };
        state = {
            semester: currentSemester,
            sourceName: shortPath,
            lastSyncedAt: savedState?.lastSyncedAt || null,
            rules: diskOverlay.rules || null,
            teachers: savedState?.teachers || diskOverlay.teachers || [],
            shifts: savedState?.shifts || diskOverlay.shifts || [],
            activities: normalizeActivities(diskOverlay.activities, baseRules),
            acknowledgedFindings: diskOverlay.acknowledgedFindings || []
        };

        state.shifts.forEach(s => {
            s.locked = Array(s.reqHosts).fill(false);
            s.tripSlots = [];
        });
        applyLockedShiftsOverlay(state.shifts, diskOverlay.lockedShifts, diskOverlay.lockedTripSlots, state.activities);
        reconcileActivityTripSlots(state);

        baseFileText = diskFileText;
        hasLocalChanges = false;
        persistWrapper();

        if (SETTINGS.semesters[currentSemester].googleSheetCsvUrl) {
            await syncFromGoogleSheet(true, diskOverlay.lockedShifts, diskOverlay.lockedTripSlots);
        } else {
            onDataLoaded(`📁 Fil: ${shortPath}`);
        }
        return;
    }

    if (savedState) {
        state = savedState;
        if (!Array.isArray(state.acknowledgedFindings)) state.acknowledgedFindings = [];
        state.activities = normalizeActivities(state.activities, getEffectiveRules());
        reconcileActivityTripSlots(state);
        baseFileText = diskFileText;
        hasLocalChanges = true;
        persistWrapper();
        onDataLoaded(`📝 Arbejdskopi (localStorage)`, `Lokale ændringer · eksporter til ${shortPath}`);
        return;
    }

    state = {
        semester: currentSemester,
        sourceName: "Ny plan",
        lastSyncedAt: null,
        rules: null,
        teachers: [],
        shifts: [],
        activities: normalizeActivities(SETTINGS.semesters[currentSemester].presetActivities || [], getEffectiveRules()),
        acknowledgedFindings: []
    };
    baseFileText = null;
    hasLocalChanges = false;

    if (SETTINGS.semesters[currentSemester].googleSheetCsvUrl) {
        await syncFromGoogleSheet(true);
    } else {
        onDataLoaded(`Klar`, `Importer CSV eller opret ${shortPath}`);
    }
}

function persistWrapper() {
    state.semester = currentSemester;
    window.semesterSnapshots[currentSemester] = state;
    localStorage.setItem(getStorageKey(currentSemester), JSON.stringify({
        baseFileText,
        dirty: hasLocalChanges,
        state
    }));
}

function switchSemester(newSem) {
    currentSemester = newSem;
    localStorage.setItem("vaertsplan_active_semester", newSem);
    selectedActivityTeachers.clear();
    editingActivityId = null;
    initApp();
}

function saveState(rerender = true) {
    hasLocalChanges = true;
    persistWrapper();
    const shortPath = (SETTINGS.semesters[currentSemester].defaultJsonPath || "").replace("./", "");
    setStatusBadge(
        "📝 Ikke gemt i fil",
        `Lokale ændringer i localStorage${shortPath ? " · Klik 'Eksporter JSON' for at overskrive " + shortPath : ""}`
    );
    if (rerender) renderAll();
}

function onDataLoaded(badgeText, tooltip = "") {
    setStatusBadge(badgeText, tooltip);
    populateMonthFilter();
    renderAll();
    preloadOtherSemesters();
}

function renderAll() {
    window.AppUI.renderAll(state, getEffectiveRules(), selectedActivityTeachers, editingActivityId);
}

// --- ÅRSOVERSIGT: INDLÆS BEGGE SEMESTRE ---
async function loadSemesterSnapshot(semKey, forceFresh = false) {
    if (semKey === currentSemester && !forceFresh) {
        window.semesterSnapshots[semKey] = state;
        return state;
    }

    if (!forceFresh) {
        const rawSaved = localStorage.getItem(getStorageKey(semKey));
        if (rawSaved) {
            const parsed = JSON.parse(rawSaved);
            const savedSt = parsed.state || parsed;
            if (savedSt && Array.isArray(savedSt.teachers) && savedSt.teachers.length > 0) {
                savedSt.activities = normalizeActivities(savedSt.activities, {
                    ...SETTINGS.semesters[semKey].rules,
                    ...(savedSt.rules || {})
                });
                reconcileActivityTripSlots(savedSt);
                window.semesterSnapshots[semKey] = savedSt;
                return savedSt;
            }
        }
    }

    const semCfg = SETTINGS.semesters[semKey];
    if (!semCfg) return null;

    let diskOverlay = null;
    if (semCfg.defaultJsonPath) {
        try {
            const res = await fetch(semCfg.defaultJsonPath + "?t=" + Date.now());
            if (res.ok) diskOverlay = await res.json();
        } catch {}
    }

    const baseRules = { ...semCfg.rules, ...(diskOverlay?.rules || {}) };
    let snap = {
        semester: semKey,
        rules: diskOverlay?.rules || null,
        teachers: diskOverlay?.teachers || [],
        shifts: diskOverlay?.shifts || [],
        activities: normalizeActivities(diskOverlay?.activities || semCfg.presetActivities || [], baseRules)
    };

    if (semCfg.googleSheetCsvUrl) {
        try {
            const bustUrl = semCfg.googleSheetCsvUrl + (semCfg.googleSheetCsvUrl.includes("?") ? "&" : "?") + "t=" + Date.now();
            const res = await fetch(bustUrl);
            if (res.ok) {
                const csvText = await res.text();
                snap = window.SheetParser.parseAndMerge(csvText, "Google Sheets", snap, baseRules);
            }
        } catch {}
    }

    if (diskOverlay?.lockedShifts || diskOverlay?.lockedTripSlots) {
        snap.shifts.forEach(s => {
            s.locked = Array(s.reqHosts).fill(false);
            s.tripSlots = [];
        });
        applyLockedShiftsOverlay(snap.shifts, diskOverlay.lockedShifts, diskOverlay.lockedTripSlots, snap.activities);
    }
    snap.activities = normalizeActivities(snap.activities, baseRules);
    reconcileActivityTripSlots(snap);
    window.semesterSnapshots[semKey] = snap;
    return snap;
}

async function preloadOtherSemesters() {
    window.semesterSnapshots[currentSemester] = state;
    for (const semKey of Object.keys(SETTINGS.semesters)) {
        if (semKey !== currentSemester && !window.semesterSnapshots[semKey]) {
            await loadSemesterSnapshot(semKey, false);
        }
    }
    if (window.teacherOverviewMode === "year") {
        renderAll();
    }
}

async function setTeacherOverviewMode(mode) {
    window.teacherOverviewMode = mode;
    if (mode === "year") {
        window.semesterSnapshots[currentSemester] = state;
        renderAll();
        for (const semKey of Object.keys(SETTINGS.semesters)) {
            if (!window.semesterSnapshots[semKey]) {
                await loadSemesterSnapshot(semKey, false);
            }
        }
    }
    renderAll();
}

async function refreshAllSemestersForYear() {
    await syncFromGoogleSheet(false);
    for (const semKey of Object.keys(SETTINGS.semesters)) {
        if (semKey !== currentSemester) {
            await loadSemesterSnapshot(semKey, true);
        }
    }
    renderAll();
}

// --- OPDATERING FRA REGNEARK ---
async function syncFromGoogleSheet(keepClean = false, explicitLockedShifts = null, explicitLockedTrips = null) {
    const url = SETTINGS.semesters[currentSemester].googleSheetCsvUrl;
    if (!url) {
        alert("Der er ikke sat et CSV-link for dette semester i settings.js. Brug 'Importer CSV' eller indsæt linket i settings.js.");
        return;
    }
    setStatusBadge("⏳ Henter...");
    try {
        const bustUrl = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
        const res = await fetch(bustUrl);
        if (!res.ok) throw new Error("Netværksfejl");
        const csvText = await res.text();

        state = window.SheetParser.parseAndMerge(csvText, "Google Sheets", state, getEffectiveRules());
        if (explicitLockedShifts || explicitLockedTrips) {
            applyLockedShiftsOverlay(state.shifts, explicitLockedShifts, explicitLockedTrips, state.activities);
        }
        state.activities = normalizeActivities(state.activities, getEffectiveRules());
        reconcileActivityTripSlots(state);

        if (keepClean) {
            hasLocalChanges = false;
            persistWrapper();
            const shortPath = (SETTINGS.semesters[currentSemester].defaultJsonPath || "").replace("./", "");
            onDataLoaded(`📁 ${shortPath} · kl. ${state.lastSyncedAt}`);
        } else {
            saveState(true);
        }
    } catch (err) {
        alert("Kunne ikke hente fra regneark: " + err.message);
        setStatusBadge("❌ Fejl", err.message);
    }
}

function handleCsvUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            state = window.SheetParser.parseAndMerge(e.target.result, file.name, state, getEffectiveRules());
            state.activities = normalizeActivities(state.activities, getEffectiveRules());
            reconcileActivityTripSlots(state);
            saveState(true);
        } catch (err) {
            alert(err.message);
        }
    };
    reader.readAsText(file, "UTF-8");
    event.target.value = "";
}

// --- AUTO-UDKAST & TILDELING ---
function generateOptimalDraft() {
    if (!confirm("Vil du generere et samlet optimalt forslag for både rejseværter og skoleværter? (Alle låste vagter 🔒 bevares)")) return;
    state = window.HostPlanner.generateOptimalDraft(state, getEffectiveRules());
    saveState();
}

function clearUnlockedDrafts() {
    if (!confirm("Vil du rydde alle ulåste vagter (inkl. ulåste rejsevagter)?")) return;
    state.shifts.forEach(s => {
        for (let i = 0; i < s.reqHosts; i++) {
            if (!s.locked?.[i]) {
                s.assigned[i] = null;
                if (s.isAutoDraft) s.isAutoDraft[i] = false;
            }
        }
        if (Array.isArray(s.tripSlots)) {
            s.tripSlots = s.tripSlots.filter(ts => ts.locked);
        }
    });
    saveState();
}

function assignHost(shiftId, slotIndex, teacherId) {
    const shift = state.shifts.find(s => s.id === shiftId);
    if (!shift || shift.locked?.[slotIndex]) return;
    shift.assigned[slotIndex] = teacherId || null;
    if (!Array.isArray(shift.isAutoDraft)) shift.isAutoDraft = Array(shift.reqHosts).fill(false);
    shift.isAutoDraft[slotIndex] = false;
    if (!teacherId) shift.locked[slotIndex] = false;
    saveState();
}

function toggleLock(shiftId, slotIndex) {
    const shift = state.shifts.find(s => s.id === shiftId);
    if (!shift || !shift.assigned[slotIndex]) return;
    if (!Array.isArray(shift.locked)) shift.locked = Array(shift.reqHosts).fill(false);
    if (!Array.isArray(shift.fromSheet)) shift.fromSheet = Array(shift.reqHosts).fill(false);
    shift.locked[slotIndex] = !shift.locked[slotIndex];
    shift.fromSheet[slotIndex] = false;
    if (shift.locked[slotIndex] && shift.isAutoDraft) shift.isAutoDraft[slotIndex] = false;
    saveState();
}

function lockAllAssigned() {
    state.shifts.forEach(s => {
        if (!Array.isArray(s.locked)) s.locked = Array(s.reqHosts).fill(false);
        s.assigned.forEach((id, idx) => {
            if (id) {
                s.locked[idx] = true;
                if (s.isAutoDraft) s.isAutoDraft[idx] = false;
            }
        });
        (s.tripSlots || []).forEach(ts => {
            if (ts.teacherId) {
                ts.locked = true;
                ts.isAutoDraft = false;
            }
        });
    });
    saveState();
}

function setShiftCategory(shiftId, newCat) {
    const shift = state.shifts.find(s => s.id === shiftId);
    if (shift) {
        shift.category = newCat || "";
        saveState();
    }
}

// --- ANALYSE-HANDLINGER (CHECKBOX & 1-KLIKS BYT/FJERN) ---
function toggleFindingAck(findingId) {
    if (!Array.isArray(state.acknowledgedFindings)) state.acknowledgedFindings = [];
    const idx = state.acknowledgedFindings.indexOf(findingId);
    if (idx === -1) state.acknowledgedFindings.push(findingId);
    else state.acknowledgedFindings.splice(idx, 1);
    saveState();
}

function swapHostOnShift(shiftId, slotIndex, newTeacherId) {
    const shift = state.shifts.find(s => s.id === shiftId);
    if (!shift || !newTeacherId) return;
    shift.assigned[slotIndex] = newTeacherId;
    if (!Array.isArray(shift.locked)) shift.locked = Array(shift.reqHosts).fill(false);
    if (!Array.isArray(shift.fromSheet)) shift.fromSheet = Array(shift.reqHosts).fill(false);
    if (!Array.isArray(shift.isAutoDraft)) shift.isAutoDraft = Array(shift.reqHosts).fill(false);
    shift.locked[slotIndex] = false;
    shift.fromSheet[slotIndex] = false;
    shift.isAutoDraft[slotIndex] = false;
    saveState();
}

function removeHostFromAnalysis(shiftId, slotIndex) {
    const shift = state.shifts.find(s => s.id === shiftId);
    if (!shift) return;
    shift.assigned[slotIndex] = null;
    if (Array.isArray(shift.locked)) shift.locked[slotIndex] = false;
    if (Array.isArray(shift.fromSheet)) shift.fromSheet[slotIndex] = false;
    if (Array.isArray(shift.isAutoDraft)) shift.isAutoDraft[slotIndex] = false;
    saveState();
}

// --- REJSEVÆRT-HANDLINGER PÅ ENKELTE DAGE ---
function assignTripHost(shiftId, teacherId, activityId) {
    const shift = state.shifts.find(s => s.id === shiftId);
    if (!shift || !teacherId) return;
    if (!Array.isArray(shift.tripSlots)) shift.tripSlots = [];

    const act = state.activities.find(a => a.id === activityId);
    let isWeekendCredit = shift.isWeekend;
    if (act && act.type !== "event_host") {
        const prog = window.HostPlanner.getActivityProgress(state, act)[teacherId];
        if (prog && prog.remWknd > 0 && prog.remDay === 0) isWeekendCredit = true;
        else if (prog && prog.remDay > 0 && prog.remWknd === 0) isWeekendCredit = false;
    }

    shift.tripSlots.push({
        teacherId,
        activityId: activityId || null,
        isWeekendCredit,
        locked: false,
        isAutoDraft: false
    });
    saveState();
}

function removeTripHost(shiftId, tripSlotIndex) {
    const shift = state.shifts.find(s => s.id === shiftId);
    if (!shift || !Array.isArray(shift.tripSlots)) return;
    if (shift.tripSlots[tripSlotIndex]?.locked) return;
    shift.tripSlots.splice(tripSlotIndex, 1);
    saveState();
}

function toggleTripSlotLock(shiftId, tripSlotIndex) {
    const shift = state.shifts.find(s => s.id === shiftId);
    if (!shift || !Array.isArray(shift.tripSlots) || !shift.tripSlots[tripSlotIndex]) return;
    shift.tripSlots[tripSlotIndex].locked = !shift.tripSlots[tripSlotIndex].locked;
    if (shift.tripSlots[tripSlotIndex].locked) {
        shift.tripSlots[tripSlotIndex].isAutoDraft = false;
        shift.tripSlots[tripSlotIndex].fromSheet = false;
    }
    saveState();
}

function autoDistributeActivity(actId) {
    state = window.HostPlanner.distributeTripHosts(state, getEffectiveRules(), actId);
    saveState();
}

// --- SKOLEREJSER & ARRANGEMENTER (FORMULAR) ---
function toggleActivityTeacher(tId) {
    if (selectedActivityTeachers.has(tId)) selectedActivityTeachers.delete(tId);
    else selectedActivityTeachers.add(tId);
    renderAll();
}

function onActivityTypeChange() {
    renderAll();
}

function recalcCreditRow(inputEl) {
    const tr = inputEl.closest("tr");
    const r = getEffectiveRules();
    const isTrip = document.getElementById("act-type")?.value === "school_trip";
    const wkndRate = isTrip ? r.tripHostHours : r.weekendHours;
    const wknd = parseFloat(tr.querySelector(".cr-trip-wknd")?.value) || 0;
    const day = parseFloat(tr.querySelector(".cr-trip-day")?.value) || 0;
    const total = wknd + day;
    const hrs = wknd * wkndRate + day * r.weekdayHours;
    tr.querySelector(".cr-summary").innerHTML = `<strong>${total}</strong> værtsskab (${hrs} t)`;
}

function saveActivity() {
    const type = document.getElementById("act-type").value;
    const title = document.getElementById("act-title").value.trim();
    const start = document.getElementById("act-start").value;
    const end = document.getElementById("act-end").value || start;
    const r = getEffectiveRules();
    const bufferDays = parseInt(document.getElementById("act-buffer").value, 10) ?? r.defaultTripBufferDays;

    const noSchoolHostsCheckbox = document.getElementById("act-no-school");
    const noSchoolHosts = noSchoolHostsCheckbox ? noSchoolHostsCheckbox.checked : false;

    if (!title || !start || selectedActivityTeachers.size === 0) {
        alert("Udfyld titel, startdato og vælg mindst én lærer.");
        return;
    }

    const wkndRate = type === "school_trip" ? r.tripHostHours : r.weekendHours;
    const credits = [];
    if (type === "absence") {
        selectedActivityTeachers.forEach(tId => {
            credits.push({ teacher: tId, tripWeekendHosts: 0, tripDayHosts: 0, eventHosts: 0, hours: 0 });
        });
    } else {
        document.querySelectorAll("#act-credits-body tr").forEach(tr => {
            const tId = tr.dataset.teacher;
            const tripWeekendHosts = parseFloat(tr.querySelector(".cr-trip-wknd")?.value) || 0;
            const tripDayHosts = parseFloat(tr.querySelector(".cr-trip-day")?.value) || 0;
            const hours = tripWeekendHosts * wkndRate + tripDayHosts * r.weekdayHours;
            credits.push({ teacher: tId, tripWeekendHosts, tripDayHosts, eventHosts: 0, hours });
        });
    }

    const payload = {
        id: editingActivityId || Date.now(),
        type,
        title,
        start,
        end: end < start ? start : end,
        bufferDays,
        calendarLocked: false,
        noSchoolHosts,
        credits
    };

    if (editingActivityId) {
        const idx = state.activities.findIndex(a => a.id === editingActivityId);
        if (idx !== -1) state.activities[idx] = { ...state.activities[idx], ...payload };
    } else {
        state.activities.push(payload);
    }

    reconcileActivityTripSlots(state);
    cancelEditActivity();
    saveState();
}

function editActivity(id) {
    const act = state.activities.find(a => a.id === id);
    if (!act) return;
    editingActivityId = id;
    document.getElementById("act-type").value = act.type;
    document.getElementById("act-title").value = act.title;
    document.getElementById("act-start").value = act.start;
    document.getElementById("act-end").value = act.end;
    document.getElementById("act-buffer").value = act.bufferDays;

    const noSchoolCheckbox = document.getElementById("act-no-school");
    if (noSchoolCheckbox) noSchoolCheckbox.checked = Boolean(act.noSchoolHosts);

    selectedActivityTeachers = new Set((act.credits || []).map(c => c.teacher));
    renderAll();
    document.getElementById("tab-activities").scrollIntoView({ behavior: "smooth" });
}

function cancelEditActivity() {
    editingActivityId = null;
    document.getElementById("act-title").value = "";
    document.getElementById("act-buffer").value = getEffectiveRules().defaultTripBufferDays;

    const noSchoolCheckbox = document.getElementById("act-no-school");
    if (noSchoolCheckbox) noSchoolCheckbox.checked = false;

    selectedActivityTeachers.clear();
    renderAll();
}

function lockTripInCalendar(id) {
    const act = state.activities.find(a => a.id === id);
    if (!act) return;

    state = window.HostPlanner.distributeTripHosts(state, getEffectiveRules(), id);
    const updatedAct = state.activities.find(a => a.id === id);
    const participantIds = new Set((updatedAct?.credits || []).map(c => c.teacher));

    state.shifts.forEach(s => {
        if (s.date >= updatedAct.start && s.date <= updatedAct.end) {
            s.assigned.forEach((tId, idx) => {
                if (participantIds.has(tId)) {
                    if (!Array.isArray(s.locked)) s.locked = Array(s.reqHosts).fill(false);
                    s.locked[idx] = true;
                }
            });
            (s.tripSlots || []).forEach(ts => {
                if (ts.activityId === id || participantIds.has(ts.teacherId)) {
                    ts.locked = true;
                    ts.isAutoDraft = false;
                }
            });
        }
    });

    updatedAct.calendarLocked = true;
    saveState();
}

function unlockTripInCalendar(id) {
    const act = state.activities.find(a => a.id === id);
    if (!act) return;
    const participantIds = new Set((act.credits || []).map(c => c.teacher));

    state.shifts.forEach(s => {
        if (s.date >= act.start && s.date <= act.end) {
            if (Array.isArray(s.locked)) {
                s.assigned.forEach((tId, idx) => {
                    if (participantIds.has(tId)) s.locked[idx] = false;
                });
            }
            (s.tripSlots || []).forEach(ts => {
                if (ts.activityId === id || participantIds.has(ts.teacherId)) {
                    ts.locked = false;
                }
            });
        }
    });

    act.calendarLocked = false;
    saveState();
}

function removeActivity(id) {
    if (!confirm("Vil du slette denne registrering?")) return;
    state.activities = state.activities.filter(a => a.id !== id);
    state.shifts.forEach(s => {
        if (Array.isArray(s.tripSlots)) {
            s.tripSlots = s.tripSlots.filter(ts => ts.activityId !== id);
        }
    });
    if (editingActivityId === id) cancelEditActivity();
    saveState();
}

// --- CENTRAL REGLER & EKSPORT ---
function saveCentralRules() {
    const base = getEffectiveRules();
    state.rules = {
        ...base,
        weekdayHours: parseFloat(document.getElementById("rule-weekday-hrs").value) || 0,
        weekendHours: parseFloat(document.getElementById("rule-weekend-hrs").value) || 0,
        tripHostHours: parseFloat(document.getElementById("rule-trip-hrs").value) || 0,
        eventHostHours: parseFloat(document.getElementById("rule-event-hrs").value) || 0,
        minRestDaysBetweenShifts: parseInt(document.getElementById("rule-rest-days").value, 10) || 0,
        defaultTripBufferDays: parseInt(document.getElementById("rule-trip-buffer").value, 10) || 7
    };
    state.activities = normalizeActivities(state.activities, state.rules);
    saveState();
    alert("Timetakster og regler er opdateret.");
}

function applyActivitiesJson() {
    try {
        const parsed = JSON.parse(document.getElementById("activities-json-editor").value);
        if (!Array.isArray(parsed)) throw new Error("Skal være en JSON-liste [...]");
        state.activities = normalizeActivities(parsed, getEffectiveRules());
        reconcileActivityTripSlots(state);
        saveState();
        alert("Skolerejser & arrangementer er opdateret!");
    } catch (err) {
        alert("Fejl i JSON: " + err.message);
    }
}

function exportSettingsJsFile() {
    const updatedSettings = JSON.parse(JSON.stringify(window.APP_SETTINGS));
    const rules = getEffectiveRules();
    updatedSettings.semesters[currentSemester].rules = rules;
    updatedSettings.semesters[currentSemester].presetActivities = window.compactActivitiesForJson(state.activities, rules);

    const fileContent = `window.APP_SETTINGS = ${JSON.stringify(updatedSettings, null, 4)};\n`;
    const blob = new Blob([fileContent], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "settings.js";
    a.click();
    URL.revokeObjectURL(url);
}

function exportJson() {
    const rules = getEffectiveRules();
    const exportPayload = window.buildExportPayload(state, rules);
    const jsonString = JSON.stringify(exportPayload, null, 2);
    const filename = getJsonFilename();
    const shortPath = (SETTINGS.semesters[currentSemester].defaultJsonPath || filename).replace("./", "");

    baseFileText = jsonString.trim();
    hasLocalChanges = false;
    persistWrapper();
    setStatusBadge(`💾 Eksporteret (${filename})`, `Overskriv ${shortPath} i din projektmappe`);

    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function handleJsonUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const loaded = JSON.parse(e.target.result);
            if (loaded.rules) state.rules = loaded.rules;
            if (loaded.activities) state.activities = normalizeActivities(loaded.activities, getEffectiveRules());
            if (Array.isArray(loaded.acknowledgedFindings)) state.acknowledgedFindings = loaded.acknowledgedFindings;
            if (loaded.lockedShifts || loaded.lockedTripSlots) {
                state.shifts.forEach(s => {
                    s.locked = Array(s.reqHosts).fill(false);
                    s.tripSlots = [];
                });
                applyLockedShiftsOverlay(state.shifts, loaded.lockedShifts, loaded.lockedTripSlots, state.activities);
            }
            if ((!state.shifts || state.shifts.length === 0) && Array.isArray(loaded.shifts)) {
                state.teachers = loaded.teachers || [];
                state.shifts = loaded.shifts;
            }
            reconcileActivityTripSlots(state);
            saveState(true);
        } catch {
            alert("Ugyldig JSON-fil.");
        }
    };
    reader.readAsText(file, "UTF-8");
    event.target.value = "";
}

function copyJsonToClipboard() {
    navigator.clipboard.writeText(document.getElementById("json-preview").value)
        .then(() => alert("JSON kopieret til udklipsholder!"));
}

function resetStorage() {
    const shortPath = (SETTINGS.semesters[currentSemester].defaultJsonPath || "").replace("./", "");
    if (confirm(`Vil du slette din lokale arbejdskopi i localStorage og genindlæse fra "${shortPath}" + regnearket?`)) {
        localStorage.removeItem(getStorageKey(currentSemester));
        initApp();
    }
}

function populateMonthFilter() {
    const months = [...new Set(state.shifts.map(s => s.date.slice(0, 7)))];
    const el = document.getElementById("filter-month");
    if (el) {
        el.innerHTML = `<option value="all">Alle måneder</option>` +
            months.map(m => `<option value="${m}">${m}</option>`).join("");
    }
}

function switchTab(tabName) {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tabName));
    document.querySelectorAll(".tab-content").forEach(s => s.classList.toggle("active", s.id === `tab-${tabName}`));
}

function jumpToShiftDate(dateStr) {
    switchTab("schedule");
    const monthFilter = document.getElementById("filter-month");
    const statusFilter = document.getElementById("filter-status");
    let needRerender = false;

    if (monthFilter && monthFilter.value !== "all" && !dateStr.startsWith(monthFilter.value)) {
        monthFilter.value = "all";
        needRerender = true;
    }
    if (statusFilter && statusFilter.value !== "all") {
        statusFilter.value = "all";
        needRerender = true;
    }
    if (needRerender) renderAll();

    const row = document.querySelector(`#schedule-body tr[data-date="${dateStr}"]`);
    if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.remove("row-flash");
        void row.offsetWidth;
        row.classList.add("row-flash");
    }
}

window.addEventListener("DOMContentLoaded", initApp);