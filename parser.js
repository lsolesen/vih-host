window.SheetParser = {
    standardizeDate(dStr) {
        if (!dStr) return null;
        const m = dStr.match(/(\d{1,4})[-./](\d{1,2})[-./](\d{1,4})/);
        if (!m) return null;
        let y = m[1], mo = m[2], d = m[3];
        if (d.length === 4) { y = m[3]; d = m[1]; }
        return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    },

    parseCsvRows(text) {
        const rows = [];
        let r = [], c = "", q = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i], nx = text[i + 1];
            if (ch === '"') {
                if (q && nx === '"') { c += '"'; i++; }
                else q = !q;
            } else if (ch === "," && !q) {
                r.push(c); c = "";
            } else if ((ch === "\n" || (ch === "\r" && nx === "\n")) && !q) {
                if (ch === "\r") i++;
                r.push(c); rows.push(r); r = []; c = "";
            } else {
                c += ch;
            }
        }
        if (c || r.length) { r.push(c); rows.push(r); }
        return rows;
    },

    parseAndMerge(csvText, sourceLabel, currentState, baseRules) {
        const rows = this.parseCsvRows(csvText);
        const map = window.APP_SETTINGS.csvMapping;
        const catMap = window.APP_SETTINGS.shiftCategories || {};
        const lockFromSheet = map.lockSheetAssignments !== false;

        let headerIdx = -1, cols = {}, teacherCols = [];
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i].map(c => c.trim());
            if (r[0] === map.calendarHeaderFirstCol && r.includes(map.dateColHeader)) {
                headerIdx = i;
                cols.week = 0;
                cols.date = r.indexOf(map.dateColHeader);
                cols.weekday = r.indexOf(map.weekdayColHeader, cols.date);
                cols.assigned = r.indexOf(map.assignedColHeader);
                cols.evening = r.indexOf(map.eveningHostColHeader);
                cols.count = r.indexOf(map.countColHeader);
                if (cols.count === -1) cols.count = cols.assigned + 2;
                cols.event = r.indexOf(map.eventColHeader);
                cols.wFlag = cols.event + 1;

                let firstTeacherCol = cols.wFlag + 1;
                while (firstTeacherCol < r.length && !/^[A-ZÆØÅ]{2,4}$/.test(r[firstTeacherCol])) {
                    firstTeacherCol++;
                }
                cols.category = (firstTeacherCol > cols.wFlag + 1) ? (cols.wFlag + 1) : -1;

                for (let c = firstTeacherCol; c < r.length; c++) {
                    if (!r[c] || r[c].toLowerCase() === "i alt") break;
                    teacherCols.push({ id: r[c], colIndex: c });
                }
                break;
            }
        }

        if (headerIdx === -1) {
            throw new Error("Kunne ikke finde kalendertabellen ('Uge' / 'Dato') i CSV-filen.");
        }

        const N = teacherCols.length;
        const kvoteRowIdx = rows.findIndex(r => r.some(c => c.includes(map.quotaRowLabel)));

        let normHeaderColMap = {};
        if (kvoteRowIdx > 0) {
            const searchFrom = Math.max(0, kvoteRowIdx - 8);
            for (let i = kvoteRowIdx - 1; i >= searchFrom; i--) {
                const trimmed = rows[i].map(c => c.trim());
                if (trimmed[0] === map.calendarHeaderFirstCol) continue;
                const matches = {};
                teacherCols.forEach(t => {
                    const cIdx = trimmed.indexOf(t.id);
                    if (cIdx !== -1) matches[t.id] = cIdx;
                });
                if (Object.keys(matches).length >= Math.max(3, Math.floor(N / 2))) {
                    normHeaderColMap = matches;
                    break;
                }
            }
        }

        const extractNormRow = (labelSubstr) => {
            for (const r of rows) {
                const idx = r.findIndex(c => c.includes(labelSubstr));
                if (idx !== -1) {
                    const unitRaw = (r[idx + 1] || "").trim().replace(",", ".");
                    const unitVal = /^-?\d+(\.\d+)?$/.test(unitRaw) ? parseFloat(unitRaw) : null;

                    let useCalendarCols = false;
                    if (Object.keys(normHeaderColMap).length === 0 && teacherCols.length > 0) {
                        const firstCalCol = teacherCols[0].colIndex;
                        const valAtCal = (r[firstCalCol] || "").trim().replace(",", ".");
                        const valAtOffset = (r[idx + 2] || "").trim().replace(",", ".");
                        if (/^-?\d+(\.\d+)?$/.test(valAtCal) && !/^-?\d+(\.\d+)?$/.test(valAtOffset)) {
                            useCalendarCols = true;
                        }
                    }

                    const teacherVals = teacherCols.map((t, j) => {
                        let colIdx = normHeaderColMap[t.id];
                        if (colIdx === undefined) {
                            colIdx = useCalendarCols ? t.colIndex : (idx + 2 + j);
                        }
                        const raw = (r[colIdx] || "").trim().replace(",", ".");
                        const num = parseFloat(raw);
                        return isNaN(num) ? null : num;
                    });
                    return { unit: unitVal, values: teacherVals };
                }
            }
            return { unit: null, values: Array(N).fill(null) };
        };

        const quotaRow = extractNormRow(map.quotaRowLabel);
        const dayNormRow = extractNormRow(map.dayNormRowLabel);
        const wkndNormRow = extractNormRow(map.weekendNormRowLabel);
        const totalNormRow = extractNormRow(map.totalNormRowLabel);
        const poolHoursRow = extractNormRow(map.poolHoursRowLabel);

        const mergedRules = {
            ...baseRules,
            ...(currentState.rules || {}),
            weekdayHours: dayNormRow.unit || baseRules.weekdayHours,
            weekendHours: wkndNormRow.unit || baseRules.weekendHours,
            fullTimeTargetHours: poolHoursRow.unit || baseRules.fullTimeTargetHours,
            fullTimeDayShifts: dayNormRow.values.find(v => v !== null && v > 0) || baseRules.fullTimeDayShifts,
            fullTimeWeekendShifts: wkndNormRow.values.find(v => v !== null && v > 0) || baseRules.fullTimeWeekendShifts
        };

        const teachers = teacherCols.map((t, idx) => {
            const quota = quotaRow.values[idx] !== null ? quotaRow.values[idx] : 1.0;
            const targetDay = dayNormRow.values[idx] !== null ? dayNormRow.values[idx] : Math.round(quota * mergedRules.fullTimeDayShifts * 10) / 10;
            const targetWeekend = wkndNormRow.values[idx] !== null ? wkndNormRow.values[idx] : Math.round(quota * mergedRules.fullTimeWeekendShifts * 10) / 10;
            const targetTotal = totalNormRow.values[idx] !== null ? totalNormRow.values[idx] : Math.round((targetDay + targetWeekend) * 10) / 10;
            const targetHours = poolHoursRow.values[idx] !== null ? poolHoursRow.values[idx] : Math.round(quota * mergedRules.fullTimeTargetHours * 10) / 10;
            return { id: t.id, name: t.id, quota, targetDay, targetWeekend, targetTotal, targetHours };
        });

        const oldShiftMap = new Map((currentState.shifts || []).map(s => [s.id, s]));
        const shifts = [];

        for (let i = headerIdx + 1; i < rows.length; i++) {
            const r = rows[i];
            const stdDate = this.standardizeDate(r[cols.date] || "");
            if (!stdDate) continue;

            const weekday = (r[cols.weekday] || "").trim();
            const event = (r[cols.event] || "").trim();
            const wCell = (r[cols.wFlag] || "").trim().toLowerCase();
            const isWeekend = wCell === map.weekendMarker || wCell.startsWith("w") || weekday.startsWith("lør") || weekday.startsWith("søn");
            const isFriday = weekday.toLowerCase().startsWith("fre") || new Date(stdDate).getDay() === 5;

            // Læs UDELUKKENDE kategori fra kodekolonnen i regnearket (ingen automatisk gæt ud fra Viggokalender)
            let rawCat = cols.category !== -1 ? (r[cols.category] || "").trim().toLowerCase() : "";
            if (!rawCat && wCell.length > 1) {
                rawCat = wCell.replace(/^w[\s/-]*/, "");
            }
            const category = catMap[rawCat] ? rawCat : "";

            const prev = oldShiftMap.get(stdDate);

            const mainCell = r[cols.assigned] || "";
            const pipeParts = mainCell.split("|");
            const schoolPart = `${pipeParts[0] || ""} ${cols.evening !== -1 ? (r[cols.evening] || "") : ""}`;
            const pipeTripPart = pipeParts.slice(1).join(" ");

            const extractTokens = (str) => str
                .split(/[\s,;/]+/)
                .map(tok => tok.trim())
                .filter(tok => /^[A-ZÆØÅ]{2,4}$/.test(tok));

            const rawSchoolTokens = extractTokens(schoolPart);
            const pipeTripTokens = extractTokens(pipeTripPart);

            const noSchoolActs = (currentState.activities || []).filter(a =>
                a.type === "school_trip" && a.noSchoolHosts && stdDate >= a.start && stdDate < a.end
            );
            const noSchoolParticipants = new Set(
                noSchoolActs.flatMap(a => (a.credits || []).map(c => c.teacher))
            );

            const sheetAssigned = [];
            const autoTripFromSchool = [];
            rawSchoolTokens.forEach(tok => {
                if (noSchoolActs.length > 0 && (noSchoolParticipants.has(tok) || noSchoolParticipants.size === 0)) {
                    autoTripFromSchool.push(tok);
                } else {
                    sheetAssigned.push(tok);
                }
            });

            const allSheetTripHosts = [...new Set([...autoTripFromSchool, ...pipeTripTokens])];

            const rawCount = (r[cols.count] || "").trim().toLowerCase();
            let reqHosts = 0;
            if (noSchoolActs.length > 0 || rawCount === "0") {
                reqHosts = 0;
            } else if (rawCount === "x") {
                reqHosts = sheetAssigned.length;
            } else if (/^\d+$/.test(rawCount)) {
                const parsedNum = parseInt(rawCount, 10);
                const adjustedSchoolNeed = Math.max(0, parsedNum - allSheetTripHosts.length);
                reqHosts = Math.max(adjustedSchoolNeed, sheetAssigned.length);
            } else {
                reqHosts = Math.max(1, sheetAssigned.length);
            }

            const assigned = Array(reqHosts).fill(null);
            const locked = Array(reqHosts).fill(false);
            const fromSheet = Array(reqHosts).fill(false);
            const isAutoDraft = Array(reqHosts).fill(false);

            for (let idx = 0; idx < reqHosts; idx++) {
                const hadManualLock = prev && prev.locked?.[idx] && !prev.fromSheet?.[idx] && prev.assigned?.[idx];
                if (hadManualLock) {
                    assigned[idx] = prev.assigned[idx];
                    locked[idx] = true;
                } else if (sheetAssigned[idx]) {
                    assigned[idx] = sheetAssigned[idx];
                    locked[idx] = lockFromSheet;
                    fromSheet[idx] = true;
                } else if (prev && prev.assigned?.[idx] && !prev.fromSheet?.[idx]) {
                    assigned[idx] = prev.assigned[idx];
                    locked[idx] = Boolean(prev.locked?.[idx]);
                    isAutoDraft[idx] = Boolean(prev.isAutoDraft?.[idx] && !locked[idx]);
                }
            }

            const existingTripSlots = Array.isArray(prev?.tripSlots) ? prev.tripSlots.filter(ts => !ts.fromSheet) : [];
            const matchingAct = (currentState.activities || []).find(a => stdDate >= a.start && stdDate <= a.end);
            const existingIds = new Set(existingTripSlots.map(ts => ts.teacherId));

            const sheetTripSlotObjs = allSheetTripHosts
                .filter(tId => !existingIds.has(tId))
                .map(tId => ({
                    teacherId: tId,
                    activityId: matchingAct ? matchingAct.id : null,
                    isWeekendCredit: isWeekend,
                    locked: lockFromSheet,
                    fromSheet: true,
                    isAutoDraft: false
                }));

            const tripSlots = [...sheetTripSlotObjs, ...existingTripSlots];

            const wishes = {};
            teacherCols.forEach(t => {
                wishes[t.id] = (r[t.colIndex] || "").trim().toLowerCase();
            });

            shifts.push({
                id: stdDate,
                week: (r[cols.week] || "").trim(),
                date: stdDate,
                weekday,
                event,
                isWeekend,
                isFriday,
                category,
                reqHosts,
                assigned,
                locked,
                fromSheet,
                isAutoDraft,
                tripSlots,
                wishes
            });
        }

        return {
            ...currentState,
            sourceName: sourceLabel,
            lastSyncedAt: new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }),
            rules: mergedRules,
            teachers,
            shifts
        };
    }
};