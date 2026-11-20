// ============================================================================
// INDSTILLINGER TIL AUTO-FORDELING (Justér værdierne her for at teste)
// ============================================================================
const PLANNER_TUNING = {
    // 1. Lige startprioritet efter rejser & låste vagter
    equalInitialPriority: true,   // true = alle starter på 0% fremdrift (80% og rejselærere prioriteres lige højt fra dag 1)
    maxStartDelayDays: 10,        // Maks. dage fra første ledige dag til 1. vagt før opstarts-bonus/straf slår ind
    maxEndGapDays: 16,            // Maks. dage fra sidste vagt til slutningen af semestret

    // 2. Spredning mellem vagter
    idealGapFactorPass1: 0.80,    // Hvor tæt på ideal-afstanden runde 1 kræver (0.80 = mindst 80% af ideal-afstand)
    idealGapFactorPass2: 0.65,    // Lempet afstandskrav i runde 2 (0.65 = mindst 65% af ideal-afstand)
    shortGapPenaltyWeight: 45,    // Kvadratisk straf når afstanden er kortere end lærerens ideal-afstand

    // 3. Fuldtid vs. nedsat tid (ved evt. samlet underskud i semestret)
    fullTimeDeficitWeight: 1.45,  // Vægt på manglende vagter for 100%-stillinger (højere = ender tættere på 100%)
    partTimeDeficitWeight: 0.85,  // Vægt på manglende vagter for <100%-stillinger (spares IKKE i opstart, men bærer evt. rest)

    // 4. Ønsker, fredage og tunge weekender
    wishYesBonus: 260,            // Bonus for at opfylde et 'o'-ønske
    fridayBalanceWeight: 130,     // Vægt for at ramme kvote-målet for fredage
    heavyAWeekendPenalty: 100,    // Straf pr. 'a'-weekend så de fordeles jævnt
    swapOptimizationRounds: 75    // Antal bytte-runder til sidst
};

window.HostPlanner = {
    tuning: PLANNER_TUNING,
    _dayNumCache: new Map(),

    getDayNum(dStr) {
        if (!dStr) return NaN;
        let v = this._dayNumCache.get(dStr);
        if (v === undefined) {
            const p = dStr.split("-");
            v = Math.floor(Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1) / 86400000);
            this._dayNumCache.set(dStr, v);
        }
        return v;
    },

    getDow(dStr) {
        const dn = this.getDayNum(dStr);
        if (isNaN(dn)) return -1;
        return (((dn % 7) + 7) % 7 + 4) % 7; // 0 = søn, 5 = fre, 6 = lør
    },

    parseLocalDate(dStr) {
        if (!dStr) return new Date(NaN);
        const [y, m, d] = dStr.split("-").map(Number);
        return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
    },

    diffDays(d1, d2) {
        return this.getDayNum(d1) - this.getDayNum(d2);
    },

    isFridayDate(shift) {
        if (!shift || !shift.date) return false;
        if (typeof shift.isFriday === "boolean") return shift.isFriday;
        const wDayStr = (shift.weekday || "").toLowerCase();
        if (wDayStr.startsWith("fre") || wDayStr.startsWith("fri")) return true;
        return this.getDow(shift.date) === 5;
    },

    isNoSchoolHostDay(state, dateStr) {
        return (state.activities || []).some(a =>
            a.type === "school_trip" && a.noSchoolHosts && dateStr >= a.start && dateStr < a.end
        );
    },

    getEffectiveReqHosts(state, shift) {
        return this.isNoSchoolHostDay(state, shift.date) ? 0 : shift.reqHosts;
    },

    getShiftHours(shift, rules) {
        const overrides = window.APP_SETTINGS.eventHoursOverrides || {};
        for (const [kw, customHrs] of Object.entries(overrides)) {
            if (shift.event && shift.event.toLowerCase().includes(kw.toLowerCase())) {
                return customHrs;
            }
        }
        return shift.isWeekend ? rules.weekendHours : rules.weekdayHours;
    },

    isConsecutiveWeekendAllowed(d1, d2) {
        const n1 = this.getDayNum(d1), n2 = this.getDayNum(d2);
        const firstNum = n1 < n2 ? n1 : n2;
        const diff = Math.abs(n2 - n1);
        const dow1 = (((firstNum % 7) + 7) % 7 + 4) % 7;
        if (diff === 1) {
            return dow1 === 5 || dow1 === 6; // fre+lør eller lør+søn
        }
        if (diff === 2) {
            return dow1 === 5; // fre+søn i samme weekend
        }
        return false;
    },

    isAdjacentWeekdayToWeekend(d1, d2) {
        const n1 = this.getDayNum(d1), n2 = this.getDayNum(d2);
        const daysDiff = Math.abs(n2 - n1);
        if (daysDiff === 0 || daysDiff > 5) return false;

        const dow1 = (((n1 % 7) + 7) % 7 + 4) % 7;
        const dow2 = (((n2 % 7) + 7) % 7 + 4) % 7;
        const isWknd1 = (dow1 === 0 || dow1 === 6);
        const isWknd2 = (dow2 === 0 || dow2 === 6);
        if (isWknd1 === isWknd2) return false;

        const wkndNum = isWknd1 ? n1 : n2;
        const wdayNum = isWknd1 ? n2 : n1;
        const wdayDow = isWknd1 ? dow2 : dow1;
        if (wdayDow === 5) return false;

        const signedDiff = wdayNum - wkndNum;
        return (signedDiff >= -5 && signedDiff <= -2) || (signedDiff >= 1 && signedDiff <= 4);
    },

    wouldCreateTightCluster(assignedDatesList, candidateDate) {
        const len = assignedDatesList.length;
        if (len < 2) return false;

        const allDates = new Array(len + 1);
        for (let i = 0; i < len; i++) allDates[i] = assignedDatesList[i].date;
        allDates[len] = candidateDate;
        allDates.sort();

        const blocks = [];
        for (let i = 0; i < allDates.length; i++) {
            const d = allDates[i];
            if (blocks.length === 0) {
                blocks.push({ start: d, end: d });
            } else {
                const prev = blocks[blocks.length - 1];
                if (this.isConsecutiveWeekendAllowed(prev.end, d) || this.isConsecutiveWeekendAllowed(prev.start, d)) {
                    prev.end = d;
                } else {
                    blocks.push({ start: d, end: d });
                }
            }
        }

        for (let i = 0; i + 2 < blocks.length; i++) {
            if (this.diffDays(blocks[i + 2].start, blocks[i].end) <= 14) return true;
        }
        return false;
    },

    getTeacherAvailabilityProfile(teacher, state, rules = {}) {
        const shifts = state.shifts || [];
        if (shifts.length === 0 || teacher.targetTotal <= 0) {
            return {
                totalActiveSchoolDays: 0,
                availableSchoolDays: 0,
                availabilityRatio: 1,
                firstAvailDate: null,
                lastAvailDate: null,
                plannerTargetTotal: teacher.targetTotal,
                plannerTargetDay: teacher.targetDay,
                plannerTargetWeekend: teacher.targetWeekend,
                idealGap: 10
            };
        }

        const map = window.APP_SETTINGS?.csvMapping || { wishNo: ["x"] };
        const defaultBuf = rules.defaultTripBufferDays ?? 7;
        const tId = teacher.id;

        let totalActiveSchoolDays = 0;
        let availableSchoolDays = 0;
        let firstAvailDate = null;
        let lastAvailDate = null;
        let tripCreditsCount = 0;

        (state.activities || []).forEach(act => {
            const cr = (act.credits || []).find(c => c.teacher === tId);
            if (cr) {
                tripCreditsCount += (cr.tripWeekendHosts || 0) + (cr.tripDayHosts || 0) + (cr.eventHosts || 0);
            }
        });

        for (let i = 0; i < shifts.length; i++) {
            const s = shifts[i];
            if (this.getEffectiveReqHosts(state, s) <= 0) continue;
            totalActiveSchoolDays++;

            const wish = s.wishes?.[tId] || "";
            if (map.wishNo.some(w => wish.includes(w))) continue;

            let blockedByTrip = false;
            for (const act of (state.activities || [])) {
                if (!(act.credits || []).some(c => c.teacher === tId)) continue;
                const buf = parseInt(act.bufferDays ?? defaultBuf, 10) || 0;
                if (s.date >= act.start && s.date <= act.end) {
                    blockedByTrip = true;
                    break;
                }
                const before = this.diffDays(act.start, s.date);
                const after = this.diffDays(s.date, act.end);
                if ((before > 0 && before <= buf) || (after > 0 && after <= buf)) {
                    blockedByTrip = true;
                    break;
                }
            }

            if (!blockedByTrip) {
                availableSchoolDays++;
                if (!firstAvailDate) firstAvailDate = s.date;
                lastAvailDate = s.date;
            }
        }

        const availabilityRatio = totalActiveSchoolDays > 0
            ? (availableSchoolDays / totalActiveSchoolDays)
            : 1;

        const scaleFactor = availabilityRatio < 0.72
            ? Math.min(1, availabilityRatio / 0.85)
            : 1;

        const plannerTargetTotal = Math.round(teacher.targetTotal * scaleFactor * 10) / 10;
        const plannerTargetDay = Math.round(teacher.targetDay * scaleFactor * 10) / 10;
        const plannerTargetWeekend = Math.round(teacher.targetWeekend * scaleFactor * 10) / 10;

        const schoolShiftsNeeded = Math.max(1, plannerTargetTotal - tripCreditsCount);
        const estBlocks = Math.max(1, schoolShiftsNeeded - plannerTargetWeekend * 0.25);
        const rawIdeal = Math.round(availableSchoolDays / estBlocks);
        const idealGap = Math.max(7, Math.min(20, rawIdeal));

        return {
            totalActiveSchoolDays,
            availableSchoolDays,
            availabilityRatio,
            firstAvailDate,
            lastAvailDate,
            plannerTargetTotal,
            plannerTargetDay,
            plannerTargetWeekend,
            idealGap
        };
    },

    getIdealGapForTeacher(teacher, state, rules = {}) {
        return this.getTeacherAvailabilityProfile(teacher, state, rules).idealGap;
    },

    getActivityProgress(state, act) {
        const progress = {};
        const tripShifts = state.shifts.filter(s => s.date >= act.start && s.date <= act.end);

        (act.credits || []).forEach(cr => {
            const tId = cr.teacher;
            let assignedWknd = 0;
            let assignedDay = 0;
            let lockedCount = 0;

            tripShifts.forEach(s => {
                const effReq = this.getEffectiveReqHosts(state, s);
                for (let i = 0; i < effReq; i++) {
                    if (s.assigned[i] === tId) {
                        if (s.isWeekend) assignedWknd++;
                        else assignedDay++;
                        if (s.locked?.[i]) lockedCount++;
                    }
                }
                (s.tripSlots || []).forEach(ts => {
                    if (ts.teacherId === tId) {
                        const isWknd = act.type === "event_host"
                            ? s.isWeekend
                            : (typeof ts.isWeekendCredit === "boolean" ? ts.isWeekendCredit : s.isWeekend);
                        if (isWknd) assignedWknd++;
                        else assignedDay++;
                        if (ts.locked) lockedCount++;
                    }
                });
            });

            let reqWknd = Math.round(cr.tripWeekendHosts || 0);
            let reqDay = Math.round(cr.tripDayHosts || 0);
            const legacyEvt = Math.round(cr.eventHosts || 0);
            if (legacyEvt > 0 && reqWknd === 0 && reqDay === 0) {
                const hasWknd = tripShifts.some(s => s.isWeekend);
                const hasWday = tripShifts.some(s => !s.isWeekend);
                if (hasWknd && !hasWday) reqWknd = legacyEvt;
                else reqDay = legacyEvt;
            }

            progress[tId] = {
                reqWknd,
                reqDay,
                reqTotal: reqWknd + reqDay,
                assignedWknd,
                assignedDay,
                assignedTotal: assignedWknd + assignedDay,
                remWknd: Math.max(0, reqWknd - assignedWknd),
                remDay: Math.max(0, reqDay - assignedDay),
                remTotal: Math.max(0, (reqWknd + reqDay) - (assignedWknd + assignedDay)),
                lockedCount
            };
        });

        return progress;
    },

    computeStats(state, rules) {
        const stats = {};
        const totalQuota = state.teachers.reduce((sum, t) => sum + (t.quota || 0), 0);
        let totalFridaySlots = 0;

        state.shifts.forEach(s => {
            const effReq = this.getEffectiveReqHosts(state, s);
            if (effReq > 0 && this.isFridayDate(s)) {
                totalFridaySlots += effReq;
            }
        });

        state.teachers.forEach(t => {
            const targetFridays = totalQuota > 0
                ? Math.round(((t.quota / totalQuota) * totalFridaySlots) * 10) / 10
                : 0;

            stats[t.id] = {
                dayShifts: 0,
                weekendShifts: 0,
                fridayShifts: 0,
                targetFridays,
                categoryCounts: { r: 0, a: 0, "å": 0 },
                tripWeekendShifts: 0,
                tripDayShifts: 0,
                eventShifts: 0,
                totalShifts: 0,
                hours: 0,
                assignedDates: [],
                timelineItems: [],
                removalSuggestion: null
            };
        });

        state.shifts.forEach(s => {
            const isFri = this.isFridayDate(s);
            const baseHrs = this.getShiftHours(s, rules);
            const effReq = this.getEffectiveReqHosts(state, s);

            if (effReq > 0) {
                for (let slotIdx = 0; slotIdx < effReq; slotIdx++) {
                    const id = s.assigned[slotIdx];
                    if (id && stats[id]) {
                        const matchingAct = (state.activities || []).find(act =>
                            s.date >= act.start && s.date <= act.end &&
                            (act.credits || []).some(c => c.teacher === id)
                        );

                        stats[id].totalShifts += 1;
                        stats[id].hours += baseHrs;
                        if (isFri) stats[id].fridayShifts += 1;
                        if (s.category) {
                            stats[id].categoryCounts[s.category] = (stats[id].categoryCounts[s.category] || 0) + 1;
                        }

                        stats[id].assignedDates.push({
                            shiftId: s.id,
                            slotIndex: slotIdx,
                            isTripSlot: false,
                            date: s.date,
                            week: s.week,
                            weekday: s.weekday,
                            isWeekend: s.isWeekend,
                            isFriday: isFri,
                            category: s.category || "",
                            isLocked: Boolean(s.locked?.[slotIdx]),
                            wishedYes: s.wishes?.[id] === "o",
                            event: s.event
                        });

                        if (matchingAct) {
                            if (matchingAct.type === "event_host") stats[id].eventShifts += 1;
                            else if (s.isWeekend) stats[id].tripWeekendShifts += 1;
                            else stats[id].tripDayShifts += 1;
                        }

                        if (s.isWeekend) stats[id].weekendShifts += 1;
                        else stats[id].dayShifts += 1;

                        stats[id].timelineItems.push({
                            date: s.date,
                            type: matchingAct ? "special" : (s.isWeekend ? "wknd" : "day"),
                            label: `Uge ${s.week} · ${s.date} (${matchingAct ? matchingAct.title : (s.isWeekend ? "Weekend" : "Dagsvært")}${s.category ? " [" + s.category + "]" : ""}${s.event ? ": " + s.event : ""})`
                        });
                    }
                }
            }

            (s.tripSlots || []).forEach((ts, tIdx) => {
                const id = ts.teacherId;
                if (!id || !stats[id]) return;

                const act = (state.activities || []).find(a => a.id === ts.activityId)
                    || (state.activities || []).find(a => s.date >= a.start && s.date <= a.end && (a.credits || []).some(c => c.teacher === id));

                const countsAsWknd = act?.type === "event_host"
                    ? s.isWeekend
                    : (typeof ts.isWeekendCredit === "boolean" ? ts.isWeekendCredit : s.isWeekend);
                const hrs = act?.type === "event_host"
                    ? (countsAsWknd ? rules.weekendHours : rules.weekdayHours)
                    : (countsAsWknd ? rules.tripHostHours : rules.weekdayHours);

                stats[id].totalShifts += 1;
                stats[id].hours += hrs;
                if (isFri) stats[id].fridayShifts += 1;

                if (act?.type === "event_host") stats[id].eventShifts += 1;
                else if (countsAsWknd) stats[id].tripWeekendShifts += 1;
                else stats[id].tripDayShifts += 1;

                if (countsAsWknd) stats[id].weekendShifts += 1;
                else stats[id].dayShifts += 1;

                stats[id].assignedDates.push({
                    shiftId: s.id,
                    slotIndex: tIdx,
                    isTripSlot: true,
                    date: s.date,
                    week: s.week,
                    weekday: s.weekday,
                    isWeekend: countsAsWknd,
                    isFriday: isFri,
                    category: s.category || "",
                    isLocked: Boolean(ts.locked),
                    wishedYes: s.wishes?.[id] === "o",
                    event: act?.title || "Rejsevært"
                });

                stats[id].timelineItems.push({
                    date: s.date,
                    type: "special",
                    label: `Uge ${s.week} · ${s.date} (${act?.title || "Rejsevært"} – ${countsAsWknd ? "Weekend" : "Hverdag"})`
                });
            });
        });

        state.teachers.forEach(t => {
            const st = stats[t.id];
            const overBy = Math.round((st.totalShifts - t.targetTotal) * 10) / 10;
            if (overBy >= 0.9) {
                const tooManyWknd = st.weekendShifts > t.targetWeekend + 0.4;
                const removable = st.assignedDates
                    .filter(item => !item.isLocked && !item.isTripSlot)
                    .map(item => {
                        let keepScore = 0;
                        if (item.wishedYes) keepScore += 500;
                        if (tooManyWknd && item.isWeekend) keepScore -= 200;
                        if (!tooManyWknd && !item.isWeekend) keepScore -= 150;

                        let minDist = 999;
                        st.assignedDates.forEach(other => {
                            if (other.date !== item.date) {
                                const d = Math.abs(this.diffDays(other.date, item.date));
                                if (d < minDist) minDist = d;
                            }
                        });
                        keepScore += Math.min(minDist, 30);
                        return { ...item, keepScore, minDist };
                    })
                    .sort((a, b) => a.keepScore - b.keepScore);

                st.removalSuggestion = {
                    overBy,
                    bestToRemove: removable.length > 0 ? removable[0] : null
                };
            }
        });

        return stats;
    },

    distributeTripHosts(state, rules, onlyActivityId = null) {
        const nextState = JSON.parse(JSON.stringify(state));
        const targetActivities = (nextState.activities || []).filter(act =>
            act.type !== "absence" && (!onlyActivityId || act.id === onlyActivityId)
        );
        const targetIds = new Set(targetActivities.map(a => a.id));

        nextState.shifts.forEach(s => {
            if (!Array.isArray(s.tripSlots)) s.tripSlots = [];
            s.tripSlots = s.tripSlots.filter(ts => ts.locked || !targetIds.has(ts.activityId));
        });

        targetActivities.forEach(act => {
            const tripShifts = nextState.shifts.filter(s => s.date >= act.start && s.date <= act.end);
            if (tripShifts.length === 0) return;

            const wkndDays = tripShifts.filter(s => s.isWeekend);
            const nonReturnDays = tripShifts.filter(s => !s.isWeekend && (act.start === act.end || s.date < act.end));
            const allWeekdays = tripShifts.filter(s => !s.isWeekend);
            const weekdayPool = nonReturnDays.length > 0 ? nonReturnDays : (allWeekdays.length > 0 ? allWeekdays : tripShifts);
            const weekendPool = wkndDays.length > 0 ? wkndDays : weekdayPool;

            const progress = this.getActivityProgress(nextState, act);

            const participants = (act.credits || [])
                .map(cr => ({ cr, prog: progress[cr.teacher] }))
                .filter(p => p.prog && p.prog.remTotal > 0)
                .sort((a, b) => b.prog.remTotal - a.prog.remTotal);

            const pickBestDayForTeacher = (pool, teacherId, isWeekendCredit) => {
                const scored = pool.map(dayShift => {
                    const alreadyToday = (dayShift.assigned || []).includes(teacherId)
                        || (dayShift.tripSlots || []).some(ts => ts.teacherId === teacherId);
                    if (alreadyToday) return { dayShift, score: -99999 };

                    let score = 0;
                    const wish = dayShift.wishes?.[teacherId] || "";
                    if (wish === "o") score += 300;
                    if (wish === "x") score -= 900;

                    const loadOnDay = (dayShift.tripSlots || []).length;
                    score -= loadOnDay * 140;

                    tripShifts.forEach(other => {
                        if (other.id === dayShift.id) return;
                        const hasOther = (other.assigned || []).includes(teacherId)
                            || (other.tripSlots || []).some(ts => ts.teacherId === teacherId);
                        if (hasOther) {
                            const dist = Math.abs(this.diffDays(other.date, dayShift.date));
                            if (dist === 1 && !this.isConsecutiveWeekendAllowed(other.date, dayShift.date)) {
                                score -= 280;
                            } else if (this.isConsecutiveWeekendAllowed(other.date, dayShift.date)) {
                                score += 60;
                            }
                        }
                    });

                    return { dayShift, score };
                }).sort((a, b) => b.score - a.score);

                if (scored.length > 0 && scored[0].score > -50000) {
                    const chosen = scored[0].dayShift;
                    if (!Array.isArray(chosen.tripSlots)) chosen.tripSlots = [];
                    chosen.tripSlots.push({
                        teacherId,
                        activityId: act.id,
                        isWeekendCredit,
                        locked: false,
                        isAutoDraft: true
                    });
                    return true;
                }
                return false;
            };

            participants.forEach(({ cr, prog }) => {
                for (let k = 0; k < prog.remWknd; k++) {
                    if (!pickBestDayForTeacher(weekendPool, cr.teacher, true)) {
                        pickBestDayForTeacher(tripShifts, cr.teacher, true);
                    }
                }
            });

            participants.forEach(({ cr, prog }) => {
                for (let k = 0; k < prog.remDay; k++) {
                    if (!pickBestDayForTeacher(weekdayPool, cr.teacher, false)) {
                        pickBestDayForTeacher(tripShifts, cr.teacher, false);
                    }
                }
            });
        });

        return nextState;
    },

    evaluateCandidate(teacher, shift, state, stats, rules, excludeShiftIds = [], profileOverride = null, baselineStats = null) {
        const cfg = this.tuning;
        const tId = teacher.id;
        const map = window.APP_SETTINGS.csvMapping;
        const wish = shift.wishes?.[tId] || "";
        const isNo = map.wishNo.some(w => wish.includes(w));
        const isYes = map.wishYes.some(w => wish === w);
        const st = stats[tId];
        const isFri = this.isFridayDate(shift);
        const prof = profileOverride || this.getTeacherAvailabilityProfile(teacher, state, rules);
        const idealGap = prof.idealGap;

        const targetTot = prof.plannerTargetTotal;
        const targetDay = prof.plannerTargetDay;
        const targetWknd = prof.plannerTargetWeekend;

        const missingTotal = Math.round((targetTot - st.totalShifts) * 10) / 10;
        const missingDay = Math.round((targetDay - st.dayShifts) * 10) / 10;
        const missingWknd = Math.round((targetWknd - st.weekendShifts) * 10) / 10;
        const missingFri = Math.round((st.targetFridays - st.fridayShifts) * 10) / 10;
        const wouldGoOver = missingTotal <= 0.1;
        const wouldExceedDay = !shift.isWeekend && missingDay <= 0.1;
        const wouldExceedWknd = shift.isWeekend && missingWknd <= 0.1;

        // Lige startprioritet: måler fremdrift på de skolevagter, læreren mangler EFTER rejser og låste vagter
        let remainingRatio = targetTot > 0 ? Math.max(0, 1 - (st.totalShifts / targetTot)) : 0;
        let typeRemainingRatio = 0;

        if (cfg.equalInitialPriority && baselineStats && baselineStats[tId]) {
            const baseSt = baselineStats[tId];
            const schoolTotNeeded = Math.max(0.5, targetTot - baseSt.totalShifts);
            const schoolTotPlaced = Math.max(0, st.totalShifts - baseSt.totalShifts);
            remainingRatio = Math.max(0, 1 - (schoolTotPlaced / schoolTotNeeded));

            if (shift.isWeekend) {
                const wkndNeeded = Math.max(0.5, targetWknd - baseSt.weekendShifts);
                const wkndPlaced = Math.max(0, st.weekendShifts - baseSt.weekendShifts);
                typeRemainingRatio = Math.max(0, 1 - (wkndPlaced / wkndNeeded));
            } else {
                const dayNeeded = Math.max(0.5, targetDay - baseSt.dayShifts);
                const dayPlaced = Math.max(0, st.dayShifts - baseSt.dayShifts);
                typeRemainingRatio = Math.max(0, 1 - (dayPlaced / dayNeeded));
            }
        } else {
            const missingType = shift.isWeekend ? missingWknd : missingDay;
            const targetType = shift.isWeekend ? targetWknd : targetDay;
            typeRemainingRatio = targetType > 0 ? Math.max(0, missingType / targetType) : 0;
        }

        let activityNote = null;
        for (const act of (state.activities || [])) {
            const isParticipant = (act.credits || []).some(c => c.teacher === tId);
            if (!isParticipant) continue;

            if (shift.date >= act.start && shift.date <= act.end) {
                activityNote = { type: "trip", label: `🧳 På ${act.title}` };
                break;
            }
            const buf = parseInt(act.bufferDays ?? rules.defaultTripBufferDays, 10) || 0;
            if (buf > 0) {
                const before = this.diffDays(act.start, shift.date);
                const after = this.diffDays(shift.date, act.end);
                if ((before > 0 && before <= buf) || (after > 0 && after <= buf)) {
                    activityNote = { type: "buffer", label: `⏳ Hvile-buffer (${act.title})` };
                }
            }
        }

        let minDistance = 999;
        let consecutiveConflict = false;
        let weekendAdjConflict = false;
        let hasAdjacentFriOrSat = false;
        let hasSameWeekendShift = false;
        let nearbyShiftsWindow = 0;
        let earliestSchoolDate = null;

        for (let i = 0; i < st.assignedDates.length; i++) {
            const item = st.assignedDates[i];
            if (item.shiftId === shift.id || excludeShiftIds.includes(item.shiftId)) continue;
            if (!item.isTripSlot && (!earliestSchoolDate || item.date < earliestSchoolDate)) {
                earliestSchoolDate = item.date;
            }

            const d = Math.abs(this.diffDays(item.date, shift.date));
            const sameWknd = this.isConsecutiveWeekendAllowed(item.date, shift.date);

            if (sameWknd) {
                hasSameWeekendShift = true;
                if (d === 1 && this.getDow(item.date < shift.date ? item.date : shift.date) === 5) {
                    hasAdjacentFriOrSat = true;
                }
            } else {
                if (d < minDistance) minDistance = d;
                if (d === 1) consecutiveConflict = true;
                if (d <= idealGap * 1.4) nearbyShiftsWindow++;
            }

            if (this.isAdjacentWeekdayToWeekend(item.date, shift.date)) {
                weekendAdjConflict = true;
            }
        }

        const effReqCurrent = this.getEffectiveReqHosts(state, shift);
        const alreadyOnSameDay = shift.assigned.slice(0, effReqCurrent).includes(tId)
            || (shift.tripSlots || []).some(ts => ts.teacherId === tId);
        const tooClose = !hasSameWeekendShift && minDistance < rules.minRestDaysBetweenShifts;
        const tightCluster = this.wouldCreateTightCluster(st.assignedDates, shift.date);

        let score = 0;
        if (isNo) score -= 5000;
        if (alreadyOnSameDay) score -= 4000;
        if (wouldGoOver) score -= 3500;
        if (activityNote) score -= 2500;
        if (consecutiveConflict) score -= 1500;
        if (weekendAdjConflict) score -= 1200;
        if (tooClose) score -= 1100;
        if (tightCluster) score -= 600;

        if (wouldExceedDay) score -= 900;
        if (wouldExceedWknd) score -= 950;

        if (!hasSameWeekendShift && minDistance < idealGap) {
            const shortfall = idealGap - minDistance;
            score -= shortfall * shortfall * cfg.shortGapPenaltyWeight;
        }
        score -= nearbyShiftsWindow * 190;

        // Bonus for at bringe alle (også 80% og rejselærere) tidligt ind i første uge/periode
        if (prof.firstAvailDate) {
            const distFromStart = this.diffDays(shift.date, prof.firstAvailDate);
            if (distFromStart <= cfg.maxStartDelayDays && (!earliestSchoolDate || this.diffDays(earliestSchoolDate, prof.firstAvailDate) > cfg.maxStartDelayDays)) {
                score += 280;
            }
        }

        if (isYes) score += cfg.wishYesBonus;
        if (hasAdjacentFriOrSat) score += 120;

        // Ensartet skala for alle lærere i den indledende fordeling
        score += remainingRatio * 750;
        score += typeRemainingRatio * 420;

        if (isFri) {
            if (missingFri > 0.2) score += missingFri * cfg.fridayBalanceWeight;
            else if (missingFri <= -0.4) score -= 280;
        }

        if (shift.isWeekend && shift.category === "a") {
            let wkndACount = 0;
            for (let i = 0; i < st.assignedDates.length; i++) {
                if (st.assignedDates[i].isWeekend && st.assignedDates[i].category === "a") wkndACount++;
            }
            score -= wkndACount * cfg.heavyAWeekendPenalty;
        }

        score += Math.min(minDistance, idealGap * 1.8) * 7;

        return {
            score,
            isYes,
            isNo,
            wouldGoOver,
            wouldExceedDay,
            wouldExceedWknd,
            activityNote,
            alreadyOnSameDay,
            consecutiveConflict,
            weekendAdjConflict,
            tooClose,
            tightCluster,
            minDistance,
            idealGap,
            missingTotal: Math.round((teacher.targetTotal - st.totalShifts) * 10) / 10,
            missingDay: Math.round((teacher.targetDay - st.dayShifts) * 10) / 10,
            missingWknd: Math.round((teacher.targetWeekend - st.weekendShifts) * 10) / 10,
            missingFri
        };
    },

    fastPlanPenalty(draft, rules, activeTeachers, profById, targetFridaysMap) {
        const cfg = this.tuning;
        const totals = {};
        const days = {};
        const wknds = {};
        const fris = {};
        const datesByTeacher = {};
        let wishBonus = 0;

        for (let i = 0; i < activeTeachers.length; i++) {
            const id = activeTeachers[i].id;
            totals[id] = 0;
            days[id] = 0;
            wknds[id] = 0;
            fris[id] = 0;
            datesByTeacher[id] = [];
        }

        for (let sIdx = 0; sIdx < draft.shifts.length; sIdx++) {
            const s = draft.shifts[sIdx];
            const effReq = s._effReq;
            const isFri = s._isFri;

            for (let i = 0; i < effReq; i++) {
                const id = s.assigned[i];
                if (id && totals[id] !== undefined) {
                    totals[id]++;
                    if (s.isWeekend) wknds[id]++;
                    else days[id]++;
                    if (isFri) fris[id]++;
                    datesByTeacher[id].push({ date: s.date, isWeekend: s.isWeekend, category: s.category });
                    if (s.wishes?.[id] === "o") wishBonus += 80;
                }
            }

            const tSlots = s.tripSlots;
            if (tSlots) {
                for (let i = 0; i < tSlots.length; i++) {
                    const ts = tSlots[i];
                    const id = ts.teacherId;
                    if (id && totals[id] !== undefined) {
                        totals[id]++;
                        if (ts.isWeekendCredit) wknds[id]++;
                        else days[id]++;
                        if (isFri) fris[id]++;
                        datesByTeacher[id].push({ date: s.date, isWeekend: ts.isWeekendCredit, category: s.category });
                    }
                }
            }
        }

        let penalty = -wishBonus;
        const focusGapTeacherIds = new Set();

        for (let i = 0; i < activeTeachers.length; i++) {
            const t = activeTeachers[i];
            const id = t.id;
            const prof = profById[id];
            const tot = totals[id];

            // Fuldtidsstillinger vægtes højere på slutmålet end nedsat tid
            const deficitWeight = t.quota >= 1.0 ? cfg.fullTimeDeficitWeight : cfg.partTimeDeficitWeight;

            const diffTotal = tot - prof.plannerTargetTotal;
            if (diffTotal > 0.1) {
                penalty += diffTotal * 8000;
            } else {
                const under = Math.abs(diffTotal);
                penalty += under * under * 650 * deficitWeight;
            }

            const diffDay = Math.abs(days[id] - prof.plannerTargetDay);
            const diffWknd = Math.abs(wknds[id] - prof.plannerTargetWeekend);
            penalty += diffDay * diffDay * 300 * deficitWeight;
            penalty += diffWknd * diffWknd * 360 * deficitWeight;
            penalty += Math.abs(fris[id] - targetFridaysMap[id]) * 260;

            const idealGap = prof.idealGap || 10;
            const minGoodGap = Math.max(rules.minRestDaysBetweenShifts, Math.round(idealGap * cfg.idealGapFactorPass1));
            const maxGoodGap = Math.round(idealGap * 1.9);

            const arr = datesByTeacher[id];
            if (arr.length > 0) {
                arr.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));

                if (prof.firstAvailDate && arr.length >= 4) {
                    const leadingGap = this.diffDays(arr[0].date, prof.firstAvailDate);
                    if (leadingGap > cfg.maxStartDelayDays) {
                        penalty += (leadingGap - cfg.maxStartDelayDays) * 55;
                        focusGapTeacherIds.add(id);
                    }
                }

                if (prof.lastAvailDate && arr.length >= 4) {
                    const trailingGap = this.diffDays(prof.lastAvailDate, arr[arr.length - 1].date);
                    if (trailingGap > cfg.maxEndGapDays) {
                        penalty += (trailingGap - cfg.maxEndGapDays) * 45;
                        focusGapTeacherIds.add(id);
                    }
                }

                let wkndCount = 0, wkndACount = 0;
                for (let k = 0; k < arr.length; k++) {
                    if (arr[k].isWeekend) {
                        wkndCount++;
                        if (arr[k].category === "a") wkndACount++;
                    }
                    if (k > 0) {
                        const d = this.diffDays(arr[k].date, arr[k - 1].date);
                        if (!this.isConsecutiveWeekendAllowed(arr[k - 1].date, arr[k].date)) {
                            if (d < rules.minRestDaysBetweenShifts) {
                                penalty += (rules.minRestDaysBetweenShifts - d) * 1400;
                                focusGapTeacherIds.add(id);
                            } else if (d < minGoodGap) {
                                const short = minGoodGap - d;
                                penalty += short * short * 150;
                                focusGapTeacherIds.add(id);
                            } else if (d > maxGoodGap && arr.length >= 5) {
                                penalty += (d - maxGoodGap) * 28;
                                focusGapTeacherIds.add(id);
                            }
                        }
                    }
                    if (k >= 2) {
                        const span = this.diffDays(arr[k].date, arr[k - 2].date);
                        if (span <= 14 && !this.isConsecutiveWeekendAllowed(arr[k - 2].date, arr[k - 1].date) && !this.isConsecutiveWeekendAllowed(arr[k - 1].date, arr[k].date)) {
                            penalty += 600;
                            focusGapTeacherIds.add(id);
                        }
                    }
                }
                if (wkndACount >= 3 && wkndACount / Math.max(1, wkndCount) >= 0.65) {
                    penalty += 300;
                }
            }
        }

        return { penalty, totals, days, wknds, fris, focusGapTeacherIds };
    },

    // --- TRIN 1: REJSER -> TRIN 2: LÅSTE VAGTER -> TRIN 3: LIGE FORDELING FOR ALLE ---
    generateOptimalDraft(state, rules) {
        const cfg = this.tuning;

        // Trin 1: Læg rejseværter først
        const draft = this.distributeTripHosts(state, rules, null);
        const activeTeachers = draft.teachers.filter(t => t.quota > 0 && t.targetTotal > 0.1);

        // Trin 2: Bevar alle låste værtsskaber og ryd ulåste
        let totalFridaySlots = 0;
        draft.shifts.forEach(s => {
            s._effReq = this.getEffectiveReqHosts(draft, s);
            s._isFri = this.isFridayDate(s);
            if (s._effReq > 0 && s._isFri) totalFridaySlots += s._effReq;

            if (!Array.isArray(s.locked)) s.locked = Array(s._effReq).fill(false);
            if (!Array.isArray(s.isAutoDraft)) s.isAutoDraft = Array(s._effReq).fill(false);

            for (let i = 0; i < s._effReq; i++) {
                if (!s.locked[i]) {
                    s.assigned[i] = null;
                    s.isAutoDraft[i] = false;
                }
            }
        });

        // Gem udgangspunktet efter rejser + låste vagter, så alle derefter starter på 0% fremdrift
        const baselineStats = this.computeStats(draft, rules);

        const profById = {};
        activeTeachers.forEach(t => {
            profById[t.id] = this.getTeacherAvailabilityProfile(t, draft, rules);
        });

        const totalEffectiveQuota = activeTeachers.reduce((sum, t) => sum + t.quota * profById[t.id].availabilityRatio, 0);
        const targetFridaysMap = {};
        activeTeachers.forEach(t => {
            const effQ = t.quota * profById[t.id].availabilityRatio;
            targetFridaysMap[t.id] = totalEffectiveQuota > 0
                ? Math.round(((effQ / totalEffectiveQuota) * totalFridaySlots) * 10) / 10
                : 0;
        });

        const isIdealSpacedClean = (c) => {
            if (c.isNo || c.alreadyOnSameDay || c.wouldGoOver || c.activityNote) return false;
            if (c.consecutiveConflict || c.weekendAdjConflict || c.tooClose || c.tightCluster) return false;
            if (c.wouldExceedDay || c.wouldExceedWknd) return false;
            const minTarget = Math.max(rules.minRestDaysBetweenShifts, Math.round(c.idealGap * cfg.idealGapFactorPass1));
            if (c.minDistance < minTarget) return false;
            return true;
        };

        const isStrictTypeClean = (c) => {
            if (c.isNo || c.alreadyOnSameDay || c.wouldGoOver || c.activityNote) return false;
            if (c.consecutiveConflict || c.weekendAdjConflict || c.tooClose || c.tightCluster) return false;
            if (c.wouldExceedDay || c.wouldExceedWknd) return false;
            const minTarget = Math.max(rules.minRestDaysBetweenShifts, Math.round(c.idealGap * cfg.idealGapFactorPass2));
            if (c.minDistance < minTarget) return false;
            return true;
        };

        const isCleanCandidate = (c) => {
            if (c.isNo || c.alreadyOnSameDay || c.wouldGoOver || c.activityNote) return false;
            if (c.consecutiveConflict || c.weekendAdjConflict || c.tooClose || c.tightCluster) return false;
            return true;
        };

        const isRestSafeCandidate = (c) => {
            if (c.isNo || c.alreadyOnSameDay || c.wouldGoOver || c.activityNote) return false;
            if (c.consecutiveConflict || c.weekendAdjConflict || c.tooClose) return false;
            return true;
        };

        const isFallbackCandidate = (c) => {
            if (c.isNo || c.alreadyOnSameDay || c.wouldGoOver || c.activityNote) return false;
            if (c.consecutiveConflict) return false;
            return true;
        };

        const countCandidates = (shift, stats, filterFn) => {
            let cnt = 0;
            for (let i = 0; i < activeTeachers.length; i++) {
                const t = activeTeachers[i];
                if (filterFn(this.evaluateCandidate(t, shift, draft, stats, rules, [], profById[t.id], baselineStats))) cnt++;
            }
            return cnt;
        };

        const tryAssignBest = (shift, slotIndex, stats, filterFn, requireWish = false) => {
            let bestTeacher = null;
            let bestScore = -Infinity;

            for (let i = 0; i < activeTeachers.length; i++) {
                const t = activeTeachers[i];
                const c = this.evaluateCandidate(t, shift, draft, stats, rules, [], profById[t.id], baselineStats);
                if (!filterFn(c)) continue;
                if (requireWish && !c.isYes) continue;
                if (c.score > bestScore) {
                    bestScore = c.score;
                    bestTeacher = t;
                }
            }

            if (bestTeacher) {
                shift.assigned[slotIndex] = bestTeacher.id;
                shift.isAutoDraft[slotIndex] = true;
                return true;
            }
            return false;
        };

        const activeShifts = draft.shifts.filter(s => s._effReq > 0);

        // Trin 3A: Ønskede dage ('o') med ideal spredning
        let curStats = this.computeStats(draft, rules);
        [...activeShifts]
            .sort((a, b) => countCandidates(a, curStats, isIdealSpacedClean) - countCandidates(b, curStats, isIdealSpacedClean))
            .forEach(s => {
                for (let i = 0; i < s._effReq; i++) {
                    if (!s.assigned[i] && tryAssignBest(s, i, curStats, isIdealSpacedClean, true)) {
                        curStats = this.computeStats(draft, rules);
                    }
                }
            });

        // Trin 3B: Fyld åbne pladser med helt lige fremdrift for alle (sværeste dage først)
        for (let round = 0; round < 20; round++) {
            curStats = this.computeStats(draft, rules);
            const openShifts = activeShifts
                .filter(s => s.assigned.slice(0, s._effReq).some(v => !v))
                .sort((a, b) => countCandidates(a, curStats, isIdealSpacedClean) - countCandidates(b, curStats, isIdealSpacedClean));

            if (openShifts.length === 0) break;
            let placedAny = false;
            for (let sIdx = 0; sIdx < openShifts.length; sIdx++) {
                const s = openShifts[sIdx];
                for (let i = 0; i < s._effReq; i++) {
                    if (!s.assigned[i] && tryAssignBest(s, i, curStats, isIdealSpacedClean, false)) {
                        placedAny = true;
                        curStats = this.computeStats(draft, rules);
                    }
                }
            }
            if (!placedAny) break;
        }

        // Trin 3C: Udfyld evt. resterende pladser gradvist
        [isStrictTypeClean, isCleanCandidate, isRestSafeCandidate, isFallbackCandidate].forEach(filterFn => {
            curStats = this.computeStats(draft, rules);
            activeShifts.forEach(s => {
                for (let i = 0; i < s._effReq; i++) {
                    if (!s.assigned[i] && tryAssignBest(s, i, curStats, filterFn, false)) {
                        curStats = this.computeStats(draft, rules);
                    }
                }
            });
        });

        // Trin 4: Målrettet bytte-optimering (fuldtidsstillinger prioriteres tættest på 100%)
        const unlockedSlots = [];
        activeShifts.forEach(s => {
            for (let i = 0; i < s._effReq; i++) {
                if (!s.locked?.[i]) {
                    unlockedSlots.push({ shift: s, slotIndex: i });
                }
            }
        });

        const blockedDatesByTeacher = {};
        activeTeachers.forEach(t => {
            const set = new Set();
            activeShifts.forEach(s => {
                const wish = s.wishes?.[t.id] || "";
                if (window.APP_SETTINGS.csvMapping.wishNo.some(w => wish.includes(w))) {
                    set.add(s.date);
                    return;
                }
                for (const act of (draft.activities || [])) {
                    if (!(act.credits || []).some(c => c.teacher === t.id)) continue;
                    const buf = parseInt(act.bufferDays ?? rules.defaultTripBufferDays, 10) || 0;
                    if (s.date >= act.start && s.date <= act.end) { set.add(s.date); break; }
                    const before = this.diffDays(act.start, s.date);
                    const after = this.diffDays(s.date, act.end);
                    if ((before > 0 && before <= buf) || (after > 0 && after <= buf)) { set.add(s.date); break; }
                }
            });
            blockedDatesByTeacher[t.id] = set;
        });

        let evalState = this.fastPlanPenalty(draft, rules, activeTeachers, profById, targetFridaysMap);

        for (let iter = 0; iter < cfg.swapOptimizationRounds; iter++) {
            let improved = false;

            const underTeachers = [...activeTeachers]
                .filter(t => (profById[t.id].plannerTargetTotal - evalState.totals[t.id]) >= 0.8)
                .sort((a, b) => (profById[b.id].plannerTargetTotal - evalState.totals[b.id]) - (profById[a.id].plannerTargetTotal - evalState.totals[a.id]));

            if (underTeachers.length > 0) {
                for (let u = 0; u < unlockedSlots.length && !improved; u++) {
                    const slot = unlockedSlots[u];
                    const oldId = slot.shift.assigned[slot.slotIndex];
                    if (!oldId) continue;
                    const oldMissing = profById[oldId] ? (profById[oldId].plannerTargetTotal - evalState.totals[oldId]) : 0;

                    for (let k = 0; k < underTeachers.length; k++) {
                        const cand = underTeachers[k];
                        const candMissing = profById[cand.id].plannerTargetTotal - evalState.totals[cand.id];
                        if (cand.id === oldId || candMissing - oldMissing < 1.0) continue;
                        if (blockedDatesByTeacher[cand.id].has(slot.shift.date)) continue;
                        if (slot.shift.assigned.slice(0, slot.shift._effReq).includes(cand.id)) continue;

                        slot.shift.assigned[slot.slotIndex] = cand.id;
                        const nextEval = this.fastPlanPenalty(draft, rules, activeTeachers, profById, targetFridaysMap);
                        if (nextEval.penalty < evalState.penalty - 25) {
                            evalState = nextEval;
                            slot.shift.isAutoDraft[slot.slotIndex] = true;
                            improved = true;
                            break;
                        } else {
                            slot.shift.assigned[slot.slotIndex] = oldId;
                        }
                    }
                }
            }
            if (improved) continue;

            const focusIds = new Set([
                ...evalState.focusGapTeacherIds,
                ...activeTeachers
                    .filter(t => {
                        const prof = profById[t.id];
                        return Math.abs(evalState.days[t.id] - prof.plannerTargetDay) >= 0.8 ||
                            Math.abs(evalState.wknds[t.id] - prof.plannerTargetWeekend) >= 0.8 ||
                            Math.abs(evalState.fris[t.id] - targetFridaysMap[t.id]) >= 1.1;
                    })
                    .map(t => t.id)
            ]);
            if (focusIds.size === 0) break;

            for (let a = 0; a < unlockedSlots.length && !improved; a++) {
                const slotA = unlockedSlots[a];
                const idA = slotA.shift.assigned[slotA.slotIndex];
                if (!idA || !focusIds.has(idA)) continue;

                for (let b = 0; b < unlockedSlots.length; b++) {
                    if (a === b) continue;
                    const slotB = unlockedSlots[b];
                    if (slotA.shift.id === slotB.shift.id) continue;

                    const idB = slotB.shift.assigned[slotB.slotIndex];
                    if (!idB || idA === idB) continue;
                    if (blockedDatesByTeacher[idB].has(slotA.shift.date) || blockedDatesByTeacher[idA].has(slotB.shift.date)) continue;
                    if (slotA.shift.assigned.slice(0, slotA.shift._effReq).includes(idB)) continue;
                    if (slotB.shift.assigned.slice(0, slotB.shift._effReq).includes(idA)) continue;

                    slotA.shift.assigned[slotA.slotIndex] = idB;
                    slotB.shift.assigned[slotB.slotIndex] = idA;
                    const nextEval = this.fastPlanPenalty(draft, rules, activeTeachers, profById, targetFridaysMap);
                    if (nextEval.penalty < evalState.penalty - 25) {
                        evalState = nextEval;
                        slotA.shift.isAutoDraft[slotA.slotIndex] = true;
                        slotB.shift.isAutoDraft[slotB.slotIndex] = true;
                        improved = true;
                        break;
                    } else {
                        slotA.shift.assigned[slotA.slotIndex] = idA;
                        slotB.shift.assigned[slotB.slotIndex] = idB;
                    }
                }
            }

            if (!improved) break;
        }

        draft.shifts.forEach(s => {
            delete s._effReq;
            delete s._isFri;
        });

        return draft;
    }
};