window.PlanAnalyzer = {
    isSameWeekendPair(d1, d2) {
        return window.HostPlanner.isConsecutiveWeekendAllowed(d1, d2);
    },

    isSameTripPair(itemA, itemB, state) {
        if (!itemA?.isTripSlot || !itemB?.isTripSlot) return false;
        const d = Math.abs(window.HostPlanner.diffDays(itemA.date, itemB.date));
        if (d <= 6) return true;
        return (state.activities || []).some(act =>
            act.type === "school_trip" &&
            itemA.date >= act.start && itemA.date <= act.end &&
            itemB.date >= act.start && itemB.date <= act.end
        );
    },

    findReplacementCandidates(shift, slotIndex, oldTeacherId, state, stats, rules, underNormIds) {
        const effReq = window.HostPlanner.getEffectiveReqHosts(state, shift);
        if (effReq === 0) return [];

        const tempState = JSON.parse(JSON.stringify(state));
        const tempShift = tempState.shifts.find(s => s.id === shift.id);
        if (tempShift) {
            tempShift.assigned[slotIndex] = null;
        }
        const tempStats = window.HostPlanner.computeStats(tempState, rules);

        return tempState.teachers
            .filter(t => t.quota > 0 && t.id !== oldTeacherId)
            .map(t => ({
                teacher: t,
                isUnderNorm: underNormIds.has(t.id),
                ...window.HostPlanner.evaluateCandidate(t, tempShift, tempState, tempStats, rules)
            }))
            .filter(c => {
                if (c.isNo || c.alreadyOnSameDay || c.wouldGoOver || c.activityNote) return false;
                if (c.consecutiveConflict || c.weekendAdjConflict || c.tooClose) return false;
                return true;
            })
            .sort((a, b) => {
                if (a.isUnderNorm !== b.isUnderNorm) return a.isUnderNorm ? -1 : 1;
                if (Math.abs(b.missingTotal - a.missingTotal) > 0.2) return b.missingTotal - a.missingTotal;
                return b.score - a.score;
            })
            .slice(0, 3)
            .map(c => ({
                teacherId: c.teacher.id,
                missingTotal: c.missingTotal,
                isUnderNorm: c.isUnderNorm,
                isYes: c.isYes,
                minDistance: c.minDistance
            }));
    },

    analyzePlan(state, rules) {
        const stats = window.HostPlanner.computeStats(state, rules);
        const map = window.APP_SETTINGS.csvMapping;
        const ackedSet = new Set(state.acknowledgedFindings || []);
        const findings = [];
        const teacherRows = [];
        const underNormPool = [];

        const totalQuota = state.teachers.reduce((sum, t) => sum + (t.quota || 0), 0);
        let totalFridaySlots = 0;
        state.shifts.forEach(s => {
            const effReq = window.HostPlanner.getEffectiveReqHosts(state, s);
            if (effReq > 0 && window.HostPlanner.isFridayDate(s)) {
                totalFridaySlots += effReq;
            }
        });
        const fridaysPerFullTime = totalQuota > 0
            ? Math.round((totalFridaySlots / totalQuota) * 10) / 10
            : 0;

        // 1. Opbyg puljen af lærere der ligger under deres samlede norm
        const underNormIds = new Set();
        state.teachers.forEach(t => {
            if (t.quota <= 0) return;
            const st = stats[t.id];
            const missingTotal = Math.round((t.targetTotal - st.totalShifts) * 10) / 10;
            if (missingTotal >= 0.6) {
                underNormIds.add(t.id);
                underNormPool.push({
                    teacher: t,
                    stats: st,
                    missingTotal,
                    missingDay: Math.max(0, Math.round((t.targetDay - st.dayShifts) * 10) / 10),
                    missingWknd: Math.max(0, Math.round((t.targetWeekend - st.weekendShifts) * 10) / 10)
                });
            }
        });
        underNormPool.sort((a, b) => b.missingTotal - a.missingTotal);

        let totalWishesYes = 0;
        let grantedWishesYes = 0;
        let tripConflictCount = 0;
        let wishNoCount = 0;
        let withinNormCount = 0;

        // 2. Gennemgå hver lærer
        state.teachers.forEach(t => {
            const st = stats[t.id];
            const sorted = [...st.assignedDates].sort((a, b) => a.date.localeCompare(b.date));

            // Pauser & spredning (ignorerer sammenhængende weekend OG rejsevagter på samme skolerejse)
            let minSeparateGap = null;
            let shortGapPair = null;
            const separateGaps = [];

            for (let i = 1; i < sorted.length; i++) {
                const prevItem = sorted[i - 1];
                const currItem = sorted[i];
                const d = window.HostPlanner.diffDays(currItem.date, prevItem.date);

                if (
                    this.isSameWeekendPair(prevItem.date, currItem.date) ||
                    this.isSameTripPair(prevItem, currItem, state)
                ) {
                    continue;
                }
                separateGaps.push(d);
                if (minSeparateGap === null || d < minSeparateGap) {
                    minSeparateGap = d;
                    shortGapPair = { prev: prevItem, curr: currItem, gap: d };
                }
            }

            const avgGap = separateGaps.length > 0
                ? Math.round(separateGaps.reduce((a, b) => a + b, 0) / separateGaps.length)
                : null;

            // Klynge-tjek: 3 separate vagtblokke inden for 14 dage (samlet weekend eller samme rejse = 1 blok)
            const blocks = [];
            sorted.forEach(item => {
                if (blocks.length === 0) {
                    blocks.push({ start: item.date, end: item.date, items: [item] });
                } else {
                    const prev = blocks[blocks.length - 1];
                    const lastItem = prev.items[prev.items.length - 1];
                    const firstItem = prev.items[0];
                    if (
                        this.isSameWeekendPair(prev.end, item.date) ||
                        this.isSameWeekendPair(prev.start, item.date) ||
                        this.isSameTripPair(lastItem, item, state) ||
                        this.isSameTripPair(firstItem, item, state)
                    ) {
                        prev.end = item.date;
                        prev.items.push(item);
                    } else {
                        blocks.push({ start: item.date, end: item.date, items: [item] });
                    }
                }
            });

            let clusterInfo = null;
            for (let i = 0; i + 2 < blocks.length; i++) {
                const span = window.HostPlanner.diffDays(blocks[i + 2].start, blocks[i].end);
                if (span <= 14) {
                    const swappableMid = blocks[i + 1].items.find(x => !x.isTripSlot) || blocks[i + 1].items[0];
                    clusterInfo = {
                        text: `3 vagtperioder på ${span} dage (${blocks[i].start} – ${blocks[i + 2].end})`,
                        middleItem: swappableMid
                    };
                    break;
                }
            }

            // Ønsker ('o' og 'x')
            let tWishYesTotal = 0;
            let tWishYesGranted = 0;
            const tWishNoItems = [];

            state.shifts.forEach(s => {
                const effReq = window.HostPlanner.getEffectiveReqHosts(state, s);
                if (effReq === 0) return;
                const w = s.wishes?.[t.id] || "";
                const isYes = map.wishYes.some(code => w === code);
                const isNo = map.wishNo.some(code => w.includes(code));
                const activeSlice = s.assigned.slice(0, effReq);
                const slotIdx = activeSlice.indexOf(t.id);
                const isOn = slotIdx !== -1;

                if (isYes) {
                    tWishYesTotal++;
                    totalWishesYes++;
                    if (isOn) {
                        tWishYesGranted++;
                        grantedWishesYes++;
                    }
                }
                if (isNo && isOn) {
                    tWishNoItems.push({ shift: s, slotIndex: slotIdx });
                    wishNoCount++;
                }
            });

            // Rejse- & bufferkonflikter
            const tripIssues = [];
            sorted.forEach(item => {
                if (item.isTripSlot) return;
                (state.activities || []).forEach(act => {
                    const isParticipant = (act.credits || []).some(c => c.teacher === t.id);
                    if (!isParticipant) return;

                    if (item.date >= act.start && item.date <= act.end) {
                        const isReturnDay = item.date === act.end && act.start !== act.end;
                        tripIssues.push({
                            item,
                            msg: isReturnDay
                                ? `Skolevært på hjemkomstdagen ${item.date} for "${act.title}"`
                                : `Skolevært ${item.date} midt under "${act.title}"`
                        });
                        tripConflictCount++;
                    } else {
                        const buf = parseInt(act.bufferDays ?? rules.defaultTripBufferDays, 10) || 0;
                        const before = window.HostPlanner.diffDays(act.start, item.date);
                        const after = window.HostPlanner.diffDays(item.date, act.end);
                        if (before > 0 && before <= buf) {
                            tripIssues.push({
                                item,
                                msg: `Vagt ${item.date} kun ${before} dage før "${act.title}" (buffer: ${buf}d)`
                            });
                            tripConflictCount++;
                        } else if (after > 0 && after <= buf) {
                            tripIssues.push({
                                item,
                                msg: `Vagt ${item.date} kun ${after} dage efter "${act.title}" (buffer: ${buf}d)`
                            });
                            tripConflictCount++;
                        }
                    }
                });
            });

            const quotaDiff = Math.round((st.totalShifts - t.targetTotal) * 10) / 10;
            const friDiff = Math.round((st.fridayShifts - st.targetFridays) * 10) / 10;
            if (Math.abs(quotaDiff) <= 0.6) withinNormCount++;

            tripIssues.forEach(({ item, msg }) => {
                const shiftObj = state.shifts.find(s => s.id === item.shiftId);
                const candidates = shiftObj
                    ? this.findReplacementCandidates(shiftObj, item.slotIndex, t.id, state, stats, rules, underNormIds)
                    : [];

                findings.push({
                    id: `trip_${t.id}_${item.date}`,
                    level: "error",
                    category: "Rejsekonflikt",
                    title: `${t.id}: ${msg}`,
                    detail: candidates.length
                        ? "Forslag fra lærere med ledig kapacitet uden konflikter:"
                        : "Vælg en anden lærer under Vagtplan eller godkend undtagelsen.",
                    shiftId: item.shiftId,
                    slotIndex: item.slotIndex,
                    canRemove: true,
                    suggestions: candidates
                });
            });

            tWishNoItems.forEach(({ shift, slotIndex }) => {
                const candidates = this.findReplacementCandidates(shift, slotIndex, t.id, state, stats, rules, underNormIds);
                findings.push({
                    id: `wishno_${t.id}_${shift.date}`,
                    level: "error",
                    category: "Friønske ('x')",
                    title: `${t.id} er sat på ${shift.date}, hvor der er ønsket fri ('x')`,
                    detail: candidates.length
                        ? "Byt vagten med en lærer fra puljen under norm:"
                        : "Overvej at bytte vagten i vagtplanen.",
                    shiftId: shift.id,
                    slotIndex,
                    canRemove: true,
                    suggestions: candidates
                });
            });

            if (quotaDiff >= 0.9) {
                const rem = st.removalSuggestion?.bestToRemove;
                const shiftObj = rem ? state.shifts.find(s => s.id === rem.shiftId) : null;
                const candidates = shiftObj
                    ? this.findReplacementCandidates(shiftObj, rem.slotIndex, t.id, state, stats, rules, underNormIds)
                    : [];

                findings.push({
                    id: `over_${t.id}`,
                    level: "warn",
                    category: "Over norm",
                    title: `${t.id} har ${st.totalShifts} vagter (norm: ${t.targetTotal} → +${quotaDiff} over)`,
                    detail: rem
                        ? `Bedste vagt at flytte/fjerne er ${rem.date} (${rem.weekday}).`
                        : `Dag: ${st.dayShifts}/${t.targetDay}, Weekend: ${st.weekendShifts}/${t.targetWeekend}.`,
                    shiftId: rem?.shiftId,
                    slotIndex: rem?.slotIndex,
                    canRemove: Boolean(rem),
                    suggestions: candidates
                });
            }

            if (shortGapPair && shortGapPair.gap < rules.minRestDaysBetweenShifts) {
                const targetItem = !shortGapPair.curr.isTripSlot ? shortGapPair.curr : shortGapPair.prev;
                const shiftObj = !targetItem.isTripSlot ? state.shifts.find(s => s.id === targetItem.shiftId) : null;
                const candidates = shiftObj
                    ? this.findReplacementCandidates(shiftObj, targetItem.slotIndex, t.id, state, stats, rules, underNormIds)
                    : [];

                findings.push({
                    id: `gap_${t.id}_${shortGapPair.curr.date}`,
                    level: "warn",
                    category: "Kort pause",
                    title: `${t.id} har kun ${shortGapPair.gap} dages pause (${shortGapPair.prev.date} → ${shortGapPair.curr.date})`,
                    detail: `Minimumsreglen er sat til ${rules.minRestDaysBetweenShifts} dage (fredag + søndag i samme weekend er tilladt).`,
                    shiftId: shiftObj?.id,
                    slotIndex: targetItem.slotIndex,
                    canRemove: false,
                    suggestions: candidates
                });
            }

            if (clusterInfo) {
                const mid = clusterInfo.middleItem;
                const shiftObj = !mid.isTripSlot ? state.shifts.find(s => s.id === mid.shiftId) : null;
                const candidates = shiftObj
                    ? this.findReplacementCandidates(shiftObj, mid.slotIndex, t.id, state, stats, rules, underNormIds)
                    : [];

                findings.push({
                    id: `cluster_${t.id}_${mid.date}`,
                    level: "warn",
                    category: "Tæt klynge",
                    title: `${t.id}: ${clusterInfo.text}`,
                    detail: `Den midterste vagt (${mid.date}) kan evt. byttes ud for bedre spredning.`,
                    shiftId: shiftObj?.id,
                    slotIndex: mid.slotIndex,
                    canRemove: false,
                    suggestions: candidates
                });
            }

            if (Math.abs(friDiff) >= 1.3 && t.quota > 0) {
                const friShifts = sorted.filter(item => item.isFriday && !item.isTripSlot && !item.wishedYes);
                const pickFri = friDiff > 0 && friShifts.length > 0 ? friShifts[friShifts.length - 1] : null;
                const shiftObj = pickFri ? state.shifts.find(s => s.id === pickFri.shiftId) : null;
                const candidates = shiftObj
                    ? this.findReplacementCandidates(shiftObj, pickFri.slotIndex, t.id, state, stats, rules, underNormIds)
                    : [];

                findings.push({
                    id: `fri_${t.id}`,
                    level: "warn",
                    category: "Fredagsbalance",
                    title: `${t.id} har ${st.fridayShifts} fredage (kvote-mål: ${st.targetFridays})`,
                    detail: friDiff > 0
                        ? `Har fået ${friDiff} fredage over sin kvoteandel (${Math.round(t.quota * 100)}% af ${fridaysPerFullTime} fredage).`
                        : `Har fået ${Math.abs(friDiff)} fredage under sin kvoteandel (${Math.round(t.quota * 100)}% af ${fridaysPerFullTime} fredage).`,
                    shiftId: shiftObj?.id,
                    slotIndex: pickFri?.slotIndex,
                    canRemove: false,
                    suggestions: candidates
                });
            }

            // Sammenlign kun skoleweekender ('a' mod øvrige skoleweekender, ekskl. rejseweekender)
            const wkndItems = sorted.filter(item => item.isWeekend && !item.isTripSlot);
            const wkndACount = wkndItems.filter(item => item.category === "a").length;
            const otherWkndCount = wkndItems.length - wkndACount;
            const aSharePct = wkndItems.length > 0 ? Math.round((wkndACount / wkndItems.length) * 100) : 0;

            if (wkndACount >= 3 && aSharePct >= 65) {
                const aPick = wkndItems.find(item => item.category === "a" && !item.wishedYes);
                const shiftObj = aPick ? state.shifts.find(s => s.id === aPick.shiftId) : null;
                const candidates = shiftObj
                    ? this.findReplacementCandidates(shiftObj, aPick.slotIndex, t.id, state, stats, rules, underNormIds)
                    : [];

                findings.push({
                    id: `heavya_${t.id}`,
                    level: "warn",
                    category: "Weekendprofil ('a')",
                    title: `${t.id} har en tung 'a'-weekendprofil (${wkndACount} 'a'-weekender mod ${otherWkndCount} øvrige weekender · ${aSharePct}%)`,
                    detail: "Størstedelen af lærerens weekendvagter på skolen ligger på aktivitetsweekender ('a').",
                    shiftId: shiftObj?.id,
                    slotIndex: aPick?.slotIndex,
                    canRemove: false,
                    suggestions: candidates
                });
            }

            teacherRows.push({
                teacher: t,
                stats: st,
                quotaDiff,
                friDiff,
                minSeparateGap,
                avgGap,
                wkndACount,
                otherWkndCount,
                tWishYesTotal,
                tWishYesGranted,
                tripIssues,
                tWishNoDates: tWishNoItems.map(x => x.shift.date),
                clusterAlert: clusterInfo?.text || null
            });
        });

        findings.forEach(f => {
            f.acknowledged = ackedSet.has(f.id);
        });

        const order = { error: 0, warn: 1, ok: 2 };
        findings.sort((a, b) => {
            if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
            return order[a.level] - order[b.level];
        });

        const unackedIssues = findings.filter(f => f.level !== "ok" && !f.acknowledged);

        return {
            summary: {
                withinNormCount,
                totalActiveTeachers: state.teachers.filter(t => t.quota > 0).length,
                tripConflictCount,
                wishNoCount,
                totalWishesYes,
                grantedWishesYes,
                totalFridaySlots,
                totalQuota: Math.round(totalQuota * 100) / 100,
                fridaysPerFullTime,
                issueCount: unackedIssues.length,
                totalFindingCount: findings.filter(f => f.level !== "ok").length
            },
            underNormPool,
            findings,
            teacherRows
        };
    }
};