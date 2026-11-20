// ============================================================================
// INDSTILLINGER FOR ÅRSOVERSIGT & BUFFER (Justér timetal her efter behov)
// ============================================================================
const YEAR_OVERVIEW_CONFIG = {
    semesterBufferHours: 10, // Grøn op til 10 t pr. semester, orange hvis større, rød hvis < 0
    yearlyBufferHours: 20    // Grøn op til 20 t for hele året samlet, orange hvis større, rød hvis < 0
};

window.AppUI = {
    renderAll(state, rules, selectedTeachers, editingActivityId) {
        const stats = window.HostPlanner.computeStats(state, rules);
        this.renderSchedule(state, stats, rules);
        this.renderCalendarOverview(state, rules);
        this.renderTeachers(state, stats);
        this.renderYearOverview();
        this.renderActivities(state, rules, selectedTeachers, editingActivityId);
        this.renderAnalysis(state, rules);
        this.renderConfig(state, rules);
    },

    renderSchedule(state, stats, rules) {
        const filterStatus = document.getElementById("filter-status").value;
        const filterMonth = document.getElementById("filter-month").value;
        const showWishes = document.getElementById("toggle-wishes").checked;

        let activeDays = 0, zeroDays = 0, reqTotal = 0, assignedTotal = 0;
        let reqDay = 0, assignedDay = 0, reqWknd = 0, assignedWknd = 0, lockedCount = 0;
        let tripSlotCount = 0;

        state.shifts.forEach(s => {
            tripSlotCount += (s.tripSlots || []).length;
            lockedCount += (s.tripSlots || []).filter(ts => ts.locked).length;
            const effReq = window.HostPlanner.getEffectiveReqHosts(state, s);

            if (effReq === 0) { zeroDays++; return; }
            activeDays++;
            const activeSlice = s.assigned.slice(0, effReq);
            const filled = activeSlice.filter(Boolean).length;
            reqTotal += effReq;
            assignedTotal += filled;
            lockedCount += (s.locked || []).slice(0, effReq).filter(Boolean).length;
            if (s.isWeekend) { reqWknd += effReq; assignedWknd += filled; }
            else { reqDay += effReq; assignedDay += filled; }
        });

        const overTeachers = state.teachers
            .map(t => ({ t, st: stats[t.id] }))
            .filter(x => x.st && x.st.removalSuggestion);

        const overAlertHtml = overTeachers.length > 0 ? `
            <div class="over-alert-box">
                <strong>⚠️ Bemærk – lærere over norm (+1 eller mere):</strong>
                ${overTeachers.map(({ t, st }) => {
                    const rem = st.removalSuggestion.bestToRemove;
                    if (rem) {
                        return `<span class="over-item">
                            <strong>${t.id}</strong> (+${st.removalSuggestion.overBy} over) → Forslag: fjern <em>${rem.date} (${rem.weekday})</em>
                            <button class="btn-inline-danger" onclick="assignHost('${rem.shiftId}', ${rem.slotIndex}, '')">🗑️ Fjern vagt</button>
                        </span>`;
                    }
                    return `<span class="over-item"><strong>${t.id}</strong> (+${st.removalSuggestion.overBy} over – alle almindelige vagter er låst)</span>`;
                }).join("")}
            </div>
        ` : "";

        document.getElementById("schedule-kpis").innerHTML = `
            <div class="kpi-card">
                <div class="kpi-label">Skoleværtsskaber (fra ark)</div>
                <div class="kpi-val">${assignedTotal} / ${reqTotal} besat</div>
                <div class="kpi-sub">${reqTotal - assignedTotal === 0 ? "✅ Alle skolevagter dækket" : `Mangler ${reqTotal - assignedTotal} skolevagter`} · 🔒 ${lockedCount} låst</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Dagsværtsskaber</div>
                <div class="kpi-val">${assignedDay} / ${reqDay}</div>
                <div class="kpi-sub">Mangler ${Math.max(0, reqDay - assignedDay)} dagsvagter</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Weekendværtsskaber</div>
                <div class="kpi-val">${assignedWknd} / ${reqWknd}</div>
                <div class="kpi-sub">Mangler ${Math.max(0, reqWknd - assignedWknd)} weekendvagter</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Rejse/Arr. & Aktive dage</div>
                <div class="kpi-val">${tripSlotCount} rejse/arr.</div>
                <div class="kpi-sub">${activeDays} aktive dage (${zeroDays} med 0 udeladt)</div>
            </div>
            ${overAlertHtml}
        `;

        const tbody = document.getElementById("schedule-body");
        tbody.innerHTML = "";
        const map = window.APP_SETTINGS.csvMapping;
        const catMap = window.APP_SETTINGS.shiftCategories || {};

        state.shifts.forEach(shift => {
            if (filterMonth !== "all" && !shift.date.startsWith(filterMonth)) return;

            const isNoSchoolDay = window.HostPlanner.isNoSchoolHostDay(state, shift.date);
            const effReq = isNoSchoolDay ? 0 : shift.reqHosts;
            const activeSlice = shift.assigned.slice(0, effReq);
            const tripSlots = shift.tripSlots || [];

            const filledCount = activeSlice.filter(Boolean).length;
            const hasEmpty = filledCount < effReq;
            const hasLocked = (shift.locked || []).slice(0, effReq).some(Boolean) || tripSlots.some(ts => ts.locked);
            const hasUnlockedAssigned = activeSlice.some((id, idx) => id && !shift.locked?.[idx]);
            const dayActivities = (state.activities || []).filter(a => a.type !== "absence" && shift.date >= a.start && shift.date <= a.end);
            const hasAnySpecialSection = dayActivities.length > 0 || tripSlots.length > 0;

            const dayHasWarning = activeSlice.some(id => {
                const tObj = state.teachers.find(t => t.id === id);
                if (!tObj) return false;
                const ev = window.HostPlanner.evaluateCandidate(tObj, shift, state, stats, rules);
                return ev.isNo || ev.consecutiveConflict || ev.weekendAdjConflict || ev.tooClose || stats[id]?.removalSuggestion;
            });

            if (filterStatus === "unassigned" && !hasEmpty) return;
            if (filterStatus === "unlocked" && !hasUnlockedAssigned) return;
            if (filterStatus === "locked" && !hasLocked) return;
            if (filterStatus === "weekend" && !shift.isWeekend && !shift.event && !hasAnySpecialSection) return;
            if (filterStatus === "warnings" && !dayHasWarning) return;

            const shiftHrs = window.HostPlanner.getShiftHours(shift, rules);

            let catHtml = "";
            if (shift.category && catMap[shift.category]) {
                const info = catMap[shift.category];
                catHtml = `<span class="badge cat-badge ${info.colorClass}" title="${info.label}">${shift.category}: ${info.label}</span>`;
            }

            const returningTrips = dayActivities.filter(a => a.type === "school_trip" && a.end === shift.date);
            const activeTrips = dayActivities.filter(a => a.type === "school_trip" && a.end !== shift.date);
            const eventActivities = dayActivities.filter(a => a.type === "event_host");

            let needHtml = "";
            if (isNoSchoolDay) {
                needHtml = `<span class="need-pill need-zero" title="Ingen skoleværter påkrævet under rejsen">✈️ Ingen hjemme (0)</span>`;
            } else if (effReq === 0) {
                needHtml = `<span class="need-pill need-zero">0 skoleværter</span>`;
            } else if (filledCount >= effReq) {
                needHtml = `<span class="need-pill need-ok">✅ ${filledCount} / ${effReq} besat</span>`;
            } else if (filledCount > 0) {
                needHtml = `<span class="need-pill need-partial">⚠️ ${filledCount} / ${effReq} (mangler ${effReq - filledCount})</span>`;
            } else {
                needHtml = `<span class="need-pill need-empty">❌ 0 / ${effReq} (mangler ${effReq})</span>`;
            }

            if (tripSlots.length > 0) {
                const isOnlyEvent = eventActivities.length > 0 && activeTrips.length === 0 && returningTrips.length === 0;
                const badgeCls = isOnlyEvent ? "badge-event-slot" : "badge-trip";
                const badgeTxt = isOnlyEvent
                    ? `🎪 +${tripSlots.length} arrangementsvært(er)`
                    : `🧳 +${tripSlots.length} rejsevært(er)`;
                needHtml += `<div style="margin-top:5px;"><span class="badge ${badgeCls}">${badgeTxt}</span></div>`;
            }

            const usedSuggestionsOnRow = new Set();
            let slotsHtml = `<div class="host-slots">`;
            if (effReq === 0 && !hasAnySpecialSection) {
                slotsHtml += `<span style="font-size:12px; color:var(--muted);">${isNoSchoolDay ? "Rejsedag (skoleværter slået fra)" : "Ingen vært påkrævet denne dag"}</span>`;
            } else {
                for (let i = 0; i < effReq; i++) {
                    slotsHtml += this.buildSlotHtml(shift, i, state, stats, rules, usedSuggestionsOnRow);
                }
            }

            if (hasAnySpecialSection) {
                slotsHtml += this.buildTripSlotsHtml(shift, dayActivities, state);
            }
            slotsHtml += `</div>`;

            let wishText = "";
            if (showWishes && shift.wishes && effReq > 0) {
                const yes = Object.keys(shift.wishes).filter(k => map.wishYes.includes(shift.wishes[k]));
                const no = Object.keys(shift.wishes).filter(k => map.wishNo.some(w => shift.wishes[k]?.includes(w)));
                if (yes.length) wishText += `<div style="font-size:11px; color:var(--ok-text); margin-top:4px;">⭐ Gerne: ${yes.join(", ")}</div>`;
                if (no.length) wishText += `<div style="font-size:11px; color:var(--muted); margin-top:2px;">🚫 Ikke: ${no.join(", ")}</div>`;
            }

            let activityBadges = "";
            if (returningTrips.length) {
                activityBadges += `<br><span class="badge badge-return" title="Deltagere på rejsen foreslås ikke som skolevært">🏠 Hjemkomst (${returningTrips.map(t => t.title).join(", ")})</span>`;
            } else if (activeTrips.length) {
                activityBadges += `<br><span class="badge badge-trip">🧳 ${activeTrips.map(t => t.title).join(", ")}</span>`;
            }
            if (eventActivities.length) {
                activityBadges += `<br><span class="badge badge-event-slot">🎪 ${eventActivities.map(e => e.title).join(", ")}</span>`;
            }

            const tr = document.createElement("tr");
            if (effReq === 0 && !hasAnySpecialSection) tr.style.opacity = "0.55";
            else if (shift.isWeekend) tr.style.background = "var(--weekend-bg)";

            tr.innerHTML = `
                <td><strong>Uge ${shift.week}</strong></td>
                <td><strong>${shift.date}</strong><br><span style="color:var(--muted)">${shift.weekday}</span></td>
                <td>
                    <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
                        <span class="badge ${shift.isWeekend ? "badge-weekend" : ""}">${shift.isWeekend ? "Weekend" : "Dagsvært"}</span>
                        ${effReq > 0 ? `<span class="badge badge-hrs">${shiftHrs} t</span>` : ""}
                        ${catHtml}
                    </div>
                    ${shift.event ? `<div style="margin-top:4px;"><span class="badge badge-event">${shift.event}</span></div>` : ""}
                    ${activityBadges}
                    ${wishText}
                </td>
                <td>${needHtml}</td>
                <td>${slotsHtml}</td>
            `;
            tbody.appendChild(tr);
        });
    },

    buildTripSlotsHtml(shift, dayActivities, state) {
        const currentTripSlots = shift.tripSlots || [];
        const assignedToday = new Set([
            ...(shift.assigned || []).filter(Boolean),
            ...currentTripSlots.map(ts => ts.teacherId)
        ]);

        const hasTrips = dayActivities.some(a => a.type === "school_trip");
        const hasEvents = dayActivities.some(a => a.type === "event_host");
        const isPureEvent = hasEvents && !hasTrips;

        const eligibleParticipants = [];
        dayActivities.forEach(act => {
            const progMap = window.HostPlanner.getActivityProgress(state, act);
            (act.credits || []).forEach(cr => {
                const p = progMap[cr.teacher];
                eligibleParticipants.push({
                    teacherId: cr.teacher,
                    actId: act.id,
                    actType: act.type,
                    actTitle: act.title,
                    remTotal: p ? p.remTotal : 0,
                    remWknd: p ? p.remWknd : 0,
                    remDay: p ? p.remDay : 0,
                    alreadyToday: assignedToday.has(cr.teacher)
                });
            });
        });

        const neededSuggestions = eligibleParticipants.filter(p => !p.alreadyToday && p.remTotal > 0);
        const boxLabel = isPureEvent
            ? "🎪 Arrangementsværter:"
            : (dayActivities.length > 0 ? "🧳 Rejseværter:" : "🧳/🎪 Rejse- & arrangementsværter:");
        const boxExtraClass = isPureEvent ? "is-event-box" : "";

        let html = `<div class="trip-slots-box ${boxExtraClass}">
            <span class="trip-slots-label">${boxLabel}</span>`;

        currentTripSlots.forEach((ts, idx) => {
            const matchedAct = (state.activities || []).find(a => a.id === ts.activityId)
                || dayActivities.find(a => (a.credits || []).some(c => c.teacher === ts.teacherId))
                || (dayActivities.length === 1 ? dayActivities[0] : null);

            const isEventSlot = matchedAct?.type === "event_host";
            const isLocked = Boolean(ts.locked);
            const isDraft = Boolean(ts.isAutoDraft) && !isLocked;
            const cls = isLocked ? "is-locked" : (isDraft ? "is-draft" : (isEventSlot ? "is-event" : "is-trip"));
            const icon = isDraft ? "✨ " : (isEventSlot ? "🎪 " : "🧳 ");
            const isWkndSlot = isEventSlot ? shift.isWeekend : (ts.isWeekendCredit ?? shift.isWeekend);
            const typeTag = isEventSlot
                ? (isWkndSlot ? "arr. wknd" : "arr. dag")
                : (isWkndSlot ? "wknd" : "dag");

            html += `
                <div class="chip-group ${cls}">
                    <button class="chip-main" onclick="${isLocked ? "" : `removeTripHost('${shift.id}', ${idx})`}"
                        title="${isLocked ? "Låst fast – klik på 🔒 for at låse op" : "Klik for at fjerne"}">
                        ${icon}${ts.teacherId} <small>(${typeTag})</small> ${isLocked ? "" : "✖"}
                    </button>
                    <button class="chip-lock-btn" onclick="toggleTripSlotLock('${shift.id}', ${idx})"
                        title="${isLocked ? "Lås op" : "Lås fast"}">
                        ${isLocked ? "🔒" : "🔓"}
                    </button>
                </div>
            `;
        });

        neededSuggestions.slice(0, 4).forEach(p => {
            const isEvt = p.actType === "event_host";
            const detail = [p.remWknd > 0 ? `${p.remWknd} wknd` : null, p.remDay > 0 ? `${p.remDay} dag` : null].filter(Boolean).join(", ");
            const chipCls = isEvt ? "chip chip-event" : "chip chip-trip";
            html += `<button class="${chipCls}" onclick="assignTripHost('${shift.id}', '${p.teacherId}', ${p.actId})"
                title="Tilføj ${p.teacherId} (mangler ${detail} på ${p.actTitle})">
                + ${p.teacherId} (${detail})
            </button>`;
        });

        if (eligibleParticipants.length > 0) {
            const placeholder = isPureEvent ? "+ Tilføj arrangementsvært..." : "+ Tilføj rejsevært...";
            html += `<select class="chip-select" onchange="if(this.value){ const [tid, aid]=this.value.split(':'); assignTripHost('${shift.id}', tid, Number(aid)); this.value=''; }">
                <option value="">${placeholder}</option>
                ${eligibleParticipants.map(p => {
                    const icon = p.actType === "event_host" ? "🎪 " : "🧳 ";
                    const status = p.alreadyToday ? "✓ på i dag" : (p.remTotal > 0 ? `mangler ${p.remTotal}` : "kvote opfyldt");
                    return `<option value="${p.teacherId}:${p.actId}" ${p.alreadyToday ? "disabled" : ""}>${icon}${p.teacherId} (${status})</option>`;
                }).join("")}
            </select>`;
        }

        html += `</div>`;
        return html;
    },

    buildSlotHtml(shift, slotIndex, state, stats, rules, usedSuggestionsOnRow) {
        const currentId = shift.assigned[slotIndex];
        const isLocked = Boolean(shift.locked?.[slotIndex]);
        const isDraft = Boolean(shift.isAutoDraft?.[slotIndex]) && !isLocked;

        if (currentId) {
            const tObj = state.teachers.find(t => t.id === currentId);
            if (!tObj) {
                return `<div class="assigned-box">
                    <div class="chip-group ${isLocked ? "is-locked" : ""}">
                        <button class="chip-main" onclick="${isLocked ? "" : `assignHost('${shift.id}', ${slotIndex}, '')`}">
                            ${currentId} ${isLocked ? "" : "✖"}
                        </button>
                        <button class="chip-lock-btn" onclick="toggleLock('${shift.id}', ${slotIndex})">${isLocked ? "🔒" : "🔓"}</button>
                    </div>
                </div>`;
            }

            const ev = window.HostPlanner.evaluateCandidate(tObj, shift, state, stats, rules);
            const st = stats[currentId];
            const notes = [];
            let groupClass = isLocked ? "is-locked" : (isDraft ? "is-draft" : "");

            if (st.removalSuggestion) {
                if (!isLocked) groupClass = "is-err";
                notes.push(`⚠️ +${st.removalSuggestion.overBy} over norm`);
            }
            if (ev.isNo) { if (!isLocked) groupClass = "is-err"; notes.push("❌ Ønsket fri ('x')"); }
            if (ev.consecutiveConflict) { if (!isLocked && groupClass !== "is-err") groupClass = "is-warn"; notes.push("⚠️ 2 dage i træk uden weekend"); }
            if (ev.weekendAdjConflict) { if (!isLocked && groupClass !== "is-err") groupClass = "is-warn"; notes.push("⚠️ Hverdag tæt på weekendvagt"); }
            if (ev.activityNote) { notes.push(ev.activityNote.label); }
            if (ev.tooClose && !ev.consecutiveConflict && !ev.weekendAdjConflict) {
                notes.push(`⏳ Kun ${ev.minDistance}d pause`);
            }

            const missingLabel = ev.missingTotal > 0
                ? `mangler ${ev.missingTotal} (${ev.missingDay} dag, ${ev.missingWknd} wknd)`
                : (ev.missingTotal === 0 ? "i mål" : `+${Math.abs(ev.missingTotal)} over`);

            return `<div class="assigned-box">
                <div class="chip-group ${groupClass}" title="${isDraft ? "Auto-forslag – klik på 🔓 for at låse fast" : ""}">
                    <button class="chip-main" onclick="${isLocked ? "" : `assignHost('${shift.id}', ${slotIndex}, '')`}"
                        title="${isLocked ? "Låst fast – klik på 🔒 for at låse op" : "Klik for at fjerne"}">
                        ${isDraft ? "✨ " : ""}${ev.isYes ? "⭐ " : ""}${currentId} ${isLocked ? "" : "✖"}
                    </button>
                    <button class="chip-lock-btn" onclick="toggleLock('${shift.id}', ${slotIndex})"
                        title="${isLocked ? "Lås op" : "Lås værtsskab fast"}">
                        ${isLocked ? "🔒" : "🔓"}
                    </button>
                </div>
                <span class="missing-tag">${missingLabel}</span>
                ${notes.length ? `<span class="warnings-text ${groupClass === "is-err" ? "err-text" : ""}">${notes.join(" · ")}</span>` : ""}
            </div>`;
        }

        const candidates = state.teachers
            .filter(t => t.quota > 0)
            .map(t => ({ teacher: t, ...window.HostPlanner.evaluateCandidate(t, shift, state, stats, rules) }))
            .sort((a, b) => b.score - a.score);

        const top = candidates
            .filter(c => !c.wouldGoOver && c.score > -400 && !usedSuggestionsOnRow.has(c.teacher.id))
            .slice(0, 3);

        top.forEach(c => usedSuggestionsOnRow.add(c.teacher.id));

        let html = `<div class="suggestions-box">`;
        top.forEach(c => {
            const distLabel = c.minDistance === 999 ? "fri" : `${c.minDistance}d`;
            const label = `${c.isYes ? "⭐ " : ""}${c.teacher.id} (${distLabel} · mangler ${c.missingTotal})`;
            const cls = c.isYes ? "chip chip-wish" : "chip chip-sugg";
            html += `<button class="${cls}" onclick="assignHost('${shift.id}', ${slotIndex}, '${c.teacher.id}')"
                title="Afstand: ${distLabel} | Mangler ${c.missingTotal} (${c.missingDay} dag, ${c.missingWknd} wknd)">${label}</button>`;
        });

        html += `<select class="chip-select" onchange="assignHost('${shift.id}', ${slotIndex}, this.value)">
            <option value="">▾ Vælg skolevært...</option>
            ${candidates.map(c => {
                const distLabel = c.minDistance === 999 ? "fri" : `${c.minDistance}d`;
                const missTxt = c.wouldGoOver ? `⚠️ +${Math.abs(c.missingTotal - 1)} over norm` : `mangler ${c.missingTotal}`;
                const flag = c.isYes ? "⭐ " : (c.wouldGoOver || c.isNo ? "⚠️ " : (c.activityNote ? "🧳 " : ""));
                return `<option value="${c.teacher.id}">${flag}${c.teacher.id} (${distLabel} · ${missTxt})</option>`;
            }).join("")}
            ${window.APP_SETTINGS.externalHostCodes.map(code => `<option value="${code}">👤 ${code} (Ekstern)</option>`).join("")}
        </select></div>`;

        return html;
    },

    renderTeachers(state, stats) {
        const tbody = document.getElementById("teacher-body");
        const validDates = state.shifts.map(s => new Date(s.date).getTime()).filter(t => !isNaN(t));
        const minTs = validDates.length ? Math.min(...validDates) : 0;
        const maxTs = validDates.length ? Math.max(...validDates) : 1;
        const spanTs = Math.max(1, maxTs - minTs);

        const monthTicks = [];
        const seenMonths = new Set();
        state.shifts.forEach(s => {
            const ym = s.date.slice(0, 7);
            if (!seenMonths.has(ym)) {
                seenMonths.add(ym);
                const pct = ((new Date(s.date).getTime() - minTs) / spanTs) * 100;
                if (pct > 1 && pct < 99) monthTicks.push(pct);
            }
        });

        tbody.innerHTML = state.teachers.map(t => {
            const s = stats[t.id];
            const missingTotal = Math.round((t.targetTotal - s.totalShifts) * 10) / 10;
            const pct = t.targetTotal > 0 ? Math.min(100, Math.round((s.totalShifts / t.targetTotal) * 100)) : 100;
            const over = Boolean(s.removalSuggestion);

            const specialParts = [];
            if (s.tripWeekendShifts > 0 || s.tripDayShifts > 0) specialParts.push(`${s.tripWeekendShifts} wknd, ${s.tripDayShifts} dag`);
            if (s.eventShifts > 0) specialParts.push(`${s.eventShifts} arr.`);
            const specialTxt = specialParts.length ? specialParts.join("<br>") : "—";

            const cc = s.categoryCounts || {};
            const catMix = [
                cc.r ? `${cc.r}r` : null,
                cc.a ? `${cc.a}a` : null,
                cc["å"] ? `${cc["å"]}å` : null
            ].filter(Boolean).join(" · ") || "—";

            const statusTxt = missingTotal > 0
                ? `Mangler <strong>${missingTotal}</strong> vagter`
                : (missingTotal === 0 ? "✅ I mål" : `<span style="color:var(--err-text); font-weight:700;">⚠️ +${Math.abs(missingTotal)} over norm</span>`);

            let removeActionHtml = "";
            if (s.removalSuggestion && s.removalSuggestion.bestToRemove) {
                const rem = s.removalSuggestion.bestToRemove;
                removeActionHtml = `<div class="remove-hint">
                    Forslag: fjern <strong>${rem.date}</strong> (${rem.weekday})
                    <button class="btn-inline-danger" onclick="assignHost('${rem.shiftId}', ${rem.slotIndex}, '')">Fjern</button>
                </div>`;
            }

            const markersHtml = s.timelineItems.map(item => {
                const startTs = new Date(item.date).getTime();
                const leftPct = Math.max(1, Math.min(99, ((startTs - minTs) / spanTs) * 100));
                const cls = item.type === "special" ? "marker-special" : (item.type === "wknd" ? "marker-wknd" : "marker-day");
                return `<span class="timeline-marker ${cls}" style="left:${leftPct}%;" title="${item.label}"></span>`;
            }).join("");

            const ticksHtml = monthTicks.map(p => `<span class="timeline-month-tick" style="left:${p}%"></span>`).join("");

            return `<tr>
                <td><strong>${t.name}</strong></td>
                <td>${Math.round(t.quota * 100)}%</td>
                <td>${s.dayShifts} / <strong>${t.targetDay}</strong></td>
                <td>${s.weekendShifts} / <strong>${t.targetWeekend}</strong></td>
                <td>${s.fridayShifts} / <strong>${s.targetFridays}</strong></td>
                <td>${specialTxt}</td>
                <td><strong>${s.totalShifts}</strong> / ${t.targetTotal}</td>
                <td>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width:${pct}%;${over ? "background:#dc2626" : (pct >= 98 ? "background:#16a34a" : "")}"></div>
                    </div>
                    <div class="status-meta">
                        <span>${statusTxt}</span>
                        <span>${pct}%</span>
                    </div>
                    <div class="status-meta" style="margin-top:2px;">
                        <span>Kategori-mix: ${catMix}</span>
                        <span>${s.hours} / ${t.targetHours} t</span>
                    </div>
                    ${removeActionHtml}
                    <div class="timeline-track" title="Spredning over perioden (hold musen over markørerne)">
                        ${ticksHtml}
                        ${markersHtml}
                    </div>
                </td>
            </tr>`;
        }).join("");
    },

    renderYearOverview() {
        const mode = window.teacherOverviewMode || "semester";
        const semView = document.getElementById("teachers-semester-view");
        const yearView = document.getElementById("teachers-year-view");
        const yearActions = document.getElementById("teacher-overview-actions");
        const btnSem = document.getElementById("btn-teacher-mode-semester");
        const btnYear = document.getElementById("btn-teacher-mode-year");

        if (btnSem) btnSem.classList.toggle("active", mode === "semester");
        if (btnYear) btnYear.classList.toggle("active", mode === "year");
        if (semView) semView.style.display = mode === "semester" ? "block" : "none";
        if (yearView) yearView.style.display = mode === "year" ? "block" : "none";
        if (yearActions) yearActions.style.display = mode === "year" ? "flex" : "none";

        if (mode !== "year") return;

        const kpiEl = document.getElementById("year-overview-kpis");
        const rateEl = document.getElementById("year-rate-info");
        const theadEl = document.getElementById("year-overview-head");
        const tbodyEl = document.getElementById("year-overview-body");
        const tfootEl = document.getElementById("year-overview-foot");
        if (!tbodyEl) return;

        const snapshots = window.semesterSnapshots || {};
        const semKeys = Object.keys(window.APP_SETTINGS?.semesters || { efteraar: {}, foraar: {} });
        const snapE = snapshots[semKeys[0]];
        const snapF = snapshots[semKeys[1]];

        if (!snapE && !snapF) {
            tbodyEl.innerHTML = `<tr><td colspan="10" style="color:var(--muted); padding:16px;">⏳ Indlæser data for begge semestre...</td></tr>`;
            return;
        }

        const getRulesForSem = (semKey, snap) => ({
            ...(window.APP_SETTINGS?.semesters?.[semKey]?.rules || {}),
            ...(snap?.rules || {})
        });

        const rulesE = getRulesForSem("efteraar", snapE);
        const rulesF = getRulesForSem("foraar", snapF);

        const statsE = snapE && snapE.teachers?.length ? window.HostPlanner.computeStats(snapE, rulesE) : {};
        const statsF = snapF && snapF.teachers?.length ? window.HostPlanner.computeStats(snapF, rulesF) : {};

        const teachersE = new Map((snapE?.teachers || []).map(t => [t.id, t]));
        const teachersF = new Map((snapF?.teachers || []).map(t => [t.id, t]));
        const allIds = [...new Set([...teachersE.keys(), ...teachersF.keys()])];

        const formatBufferPill = (bufVal, maxGreen) => {
            const rounded = Math.round(bufVal * 10) / 10;
            const cls = rounded < 0 ? "buf-over" : (rounded <= maxGreen ? "buf-ok" : "buf-high");
            const txt = rounded > 0 ? `+${rounded} t` : `${rounded} t`;
            return `<span class="buf-pill ${cls}">${txt}</span>`;
        };

        const onlyDeviations = document.getElementById("toggle-year-deviations")?.checked ?? false;

        let sumUsedE = 0, sumPoolE = 0;
        let sumUsedF = 0, sumPoolF = 0;
        let sumDayE = 0, sumWkndE = 0, sumFriE = 0;
        let sumDayF = 0, sumWkndF = 0, sumFriF = 0;
        let countGreenYear = 0, countHighYear = 0, countOverYear = 0;

        const rowsData = allIds.map(id => {
            const tE = teachersE.get(id);
            const tF = teachersF.get(id);
            const sE = statsE[id];
            const sF = statsF[id];

            const dayE = sE ? sE.dayShifts : 0;
            const wkndE = sE ? sE.weekendShifts : 0;
            const friE = sE ? sE.fridayShifts : 0;
            const normDayE = tE ? tE.targetDay : 0;
            const normWkndE = tE ? tE.targetWeekend : 0;
            const hrsE = sE ? Math.round(sE.hours * 10) / 10 : 0;
            const poolE = tE ? Math.round(tE.targetHours * 10) / 10 : 0;
            const bufE = Math.round((poolE - hrsE) * 10) / 10;

            const dayF = sF ? sF.dayShifts : 0;
            const wkndF = sF ? sF.weekendShifts : 0;
            const friF = sF ? sF.fridayShifts : 0;
            const normDayF = tF ? tF.targetDay : 0;
            const normWkndF = tF ? tF.targetWeekend : 0;
            const hrsF = sF ? Math.round(sF.hours * 10) / 10 : 0;
            const poolF = tF ? Math.round(tF.targetHours * 10) / 10 : 0;
            const bufF = Math.round((poolF - hrsF) * 10) / 10;

            const totDay = dayE + dayF;
            const totWknd = wkndE + wkndF;
            const totFri = friE + friF;
            const totShifts = totDay + totWknd;
            const totNormShifts = Math.round(((tE?.targetTotal || 0) + (tF?.targetTotal || 0)) * 10) / 10;

            const totHrs = Math.round((hrsE + hrsF) * 10) / 10;
            const totPool = Math.round((poolE + poolF) * 10) / 10;
            const totBuf = Math.round((totPool - totHrs) * 10) / 10;

            sumUsedE += hrsE; sumPoolE += poolE;
            sumUsedF += hrsF; sumPoolF += poolF;
            sumDayE += dayE; sumWkndE += wkndE; sumFriE += friE;
            sumDayF += dayF; sumWkndF += wkndF; sumFriF += friF;

            if (totBuf < 0) countOverYear++;
            else if (totBuf <= YEAR_OVERVIEW_CONFIG.yearlyBufferHours) countGreenYear++;
            else countHighYear++;

            const qE = tE ? Math.round(tE.quota * 100) : null;
            const qF = tF ? Math.round(tF.quota * 100) : null;
            const quotaLabel = (qE !== null && qF !== null)
                ? (qE === qF ? `${qE}%` : `${qE}% → ${qF}%`)
                : `${qE ?? qF ?? 100}%`;

            return {
                id,
                name: (tF || tE)?.name || id,
                quotaLabel,
                dayE, wkndE, friE, normDayE, normWkndE, hrsE, poolE, bufE,
                dayF, wkndF, friF, normDayF, normWkndF, hrsF, poolF, bufF,
                totDay, totWknd, totFri, totShifts, totNormShifts,
                totHrs, totPool, totBuf
            };
        });

        const totUsedYear = Math.round((sumUsedE + sumUsedF) * 10) / 10;
        const totPoolYear = Math.round((sumPoolE + sumPoolF) * 10) / 10;
        const totBufYear = Math.round((totPoolYear - totUsedYear) * 10) / 10;
        const pctUsedYear = totPoolYear > 0 ? Math.round((totUsedYear / totPoolYear) * 100) : 0;

        if (kpiEl) {
            kpiEl.innerHTML = `
                <div class="kpi-card">
                    <div class="kpi-label">Samlet timeforbrug (Hele året)</div>
                    <div class="kpi-val">${totUsedYear} / ${totPoolYear} t (${pctUsedYear}%)</div>
                    <div class="kpi-sub">Samlet restbuffer: <strong>${totBufYear > 0 ? "+" : ""}${totBufYear} t</strong></div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">🍂 Efterår (Timer / Pulje)</div>
                    <div class="kpi-val">${Math.round(sumUsedE)} / ${Math.round(sumPoolE)} t</div>
                    <div class="kpi-sub">${sumDayE} dag (${sumFriE} fre) · ${sumWkndE} weekend</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">🌱 Forår (Timer / Pulje)</div>
                    <div class="kpi-val">${Math.round(sumUsedF)} / ${Math.round(sumPoolF)} t</div>
                    <div class="kpi-sub">${sumDayF} dag (${sumFriF} fre) · ${sumWkndF} weekend</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">Bufferfordeling (Hele året)</div>
                    <div class="kpi-val">${countGreenYear} / ${rowsData.length} grøn</div>
                    <div class="kpi-sub">🟠 ${countHighYear} over ${YEAR_OVERVIEW_CONFIG.yearlyBufferHours} t · 🔴 ${countOverYear} overskredet</div>
                </div>
            `;
        }

        if (rateEl) {
            const sameRates = rulesE.weekdayHours === rulesF.weekdayHours && rulesE.weekendHours === rulesF.weekendHours;
            const rateText = sameRates
                ? `<span class="rate-tag">Hverdag = ${rulesE.weekdayHours} t</span>
                   <span class="rate-tag">Weekend = ${rulesE.weekendHours} t</span>
                   <span class="rate-tag">Rejse-wknd = ${rulesE.tripHostHours} t</span>
                   <span class="rate-tag">Arrangement = ${rulesE.eventHostHours} t</span>`
                : `<span class="rate-tag">🍂 Efterår: Hverdag ${rulesE.weekdayHours} t · Wknd ${rulesE.weekendHours} t</span>
                   <span class="rate-tag">🌱 Forår: Hverdag ${rulesF.weekdayHours} t · Wknd ${rulesF.weekendHours} t</span>`;

            rateEl.innerHTML = `
                <div class="rate-pills">
                    <strong>⏱️ Timetakster i værtsfordelingen:</strong>
                    ${rateText}
                </div>
                <div class="rate-pills">
                    <span><strong>Buffer:</strong></span>
                    <span class="buf-pill buf-ok" style="min-width:auto; padding:1px 7px;">0–${YEAR_OVERVIEW_CONFIG.semesterBufferHours} t / 0–${YEAR_OVERVIEW_CONFIG.yearlyBufferHours} t</span>
                    <span class="buf-pill buf-high" style="min-width:auto; padding:1px 7px;">&gt; ${YEAR_OVERVIEW_CONFIG.semesterBufferHours} t / &gt; ${YEAR_OVERVIEW_CONFIG.yearlyBufferHours} t</span>
                    <span class="buf-pill buf-over" style="min-width:auto; padding:1px 7px;">&lt; 0 t</span>
                </div>
            `;
        }

        if (theadEl) {
            theadEl.innerHTML = `
                <tr>
                    <th rowspan="2" style="width:70px;">Lærer</th>
                    <th rowspan="2" style="width:75px;">Ansæt.</th>
                    <th colspan="3" class="sem-group-hdr">🍂 Efterår (${rulesE.weekdayHours} t hverdag · ${rulesE.weekendHours} t weekend)</th>
                    <th colspan="3" class="sem-group-hdr">🌱 Forår (${rulesF.weekdayHours} t hverdag · ${rulesF.weekendHours} t weekend)</th>
                    <th colspan="4" class="sem-group-hdr">🧮 Samlet år (Efterår + Forår)</th>
                </tr>
                <tr>
                    <th class="sem-group-start">Vagter<br><small>(Dag [fre] · Wknd)</small></th>
                    <th>Timer / Pulje</th>
                    <th>Buffer</th>
                    <th class="sem-group-start">Vagter<br><small>(Dag [fre] · Wknd)</small></th>
                    <th>Timer / Pulje</th>
                    <th>Buffer</th>
                    <th class="sem-group-start">Vagter i alt<br><small>(Dag [fre] · Wknd)</small></th>
                    <th>Optalt / Norm</th>
                    <th>Optalt / Pulje</th>
                    <th>Samlet buffer</th>
                </tr>
            `;
        }

        const visibleRows = onlyDeviations
            ? rowsData.filter(r => r.totBuf < 0 || r.totBuf > YEAR_OVERVIEW_CONFIG.yearlyBufferHours)
            : rowsData;

        tbodyEl.innerHTML = visibleRows.map(r => {
            const pct = r.totPool > 0 ? Math.min(100, Math.round((r.totHrs / r.totPool) * 100)) : 0;
            const barColor = r.totBuf < 0 ? "#dc2626" : (r.totBuf <= YEAR_OVERVIEW_CONFIG.yearlyBufferHours ? "#16a34a" : "#f97316");

            return `<tr>
                <td><strong>${r.name}</strong></td>
                <td>${r.quotaLabel}</td>

                <td class="sem-group-start">
                    <strong>${r.dayE}</strong>/${r.normDayE} dag <small style="color:var(--muted)">(${r.friE} fre)</small><br>
                    <strong>${r.wkndE}</strong>/${r.normWkndE} wknd
                </td>
                <td><strong>${r.hrsE}</strong> / ${r.poolE} t</td>
                <td>${formatBufferPill(r.bufE, YEAR_OVERVIEW_CONFIG.semesterBufferHours)}</td>

                <td class="sem-group-start">
                    <strong>${r.dayF}</strong>/${r.normDayF} dag <small style="color:var(--muted)">(${r.friF} fre)</small><br>
                    <strong>${r.wkndF}</strong>/${r.normWkndF} wknd
                </td>
                <td><strong>${r.hrsF}</strong> / ${r.poolF} t</td>
                <td>${formatBufferPill(r.bufF, YEAR_OVERVIEW_CONFIG.semesterBufferHours)}</td>

                <td class="sem-group-start">
                    <strong>${r.totDay}</strong> dag <small style="color:var(--muted)">(${r.totFri} fre)</small> · <strong>${r.totWknd}</strong> wknd
                </td>
                <td><strong>${r.totShifts}</strong> / ${r.totNormShifts}</td>
                <td style="min-width:130px;">
                    <div><strong>${r.totHrs}</strong> / ${r.totPool} t <small style="color:var(--muted)">(${pct}%)</small></div>
                    <div class="progress-bar" style="margin-top:4px; height:6px;">
                        <div class="progress-fill" style="width:${pct}%; background:${barColor};"></div>
                    </div>
                </td>
                <td>${formatBufferPill(r.totBuf, YEAR_OVERVIEW_CONFIG.yearlyBufferHours)}</td>
            </tr>`;
        }).join("");

        if (tfootEl) {
            const bufEAll = Math.round((sumPoolE - sumUsedE) * 10) / 10;
            const bufFAll = Math.round((sumPoolF - sumUsedF) * 10) / 10;
            tfootEl.innerHTML = `
                <tr>
                    <td colspan="2">I alt (${rowsData.length} lærere)</td>
                    <td class="sem-group-start">${sumDayE} dag (${sumFriE} fre) · ${sumWkndE} wknd</td>
                    <td>${Math.round(sumUsedE)} / ${Math.round(sumPoolE)} t</td>
                    <td>${bufEAll > 0 ? "+" : ""}${bufEAll} t</td>
                    <td class="sem-group-start">${sumDayF} dag (${sumFriF} fre) · ${sumWkndF} wknd</td>
                    <td>${Math.round(sumUsedF)} / ${Math.round(sumPoolF)} t</td>
                    <td>${bufFAll > 0 ? "+" : ""}${bufFAll} t</td>
                    <td class="sem-group-start">${sumDayE + sumDayF} dag (${sumFriE + sumFriF} fre) · ${sumWkndE + sumWkndF} wknd</td>
                    <td>${sumDayE + sumDayF + sumWkndE + sumWkndF} vagter</td>
                    <td>${totUsedYear} / ${totPoolYear} t</td>
                    <td>${totBufYear > 0 ? "+" : ""}${totBufYear} t</td>
                </tr>
            `;
        }
    },

    renderActivities(state, rules, selectedTeachers, editingActivityId) {
        const container = document.getElementById("act-teacher-pills");
        if (container) {
            if (!state.teachers || state.teachers.length === 0) {
                container.innerHTML = `
                    <div style="font-size:13px; color:var(--warn-text); background:var(--warn-bg); padding:8px 12px; border-radius:6px;">
                        ⚠️ Ingen lærere er indlæst for dette semester endnu.
                        <button type="button" class="btn btn-primary btn-sm" style="margin-left:8px;" onclick="syncFromGoogleSheet()">🔄 Hent lærere fra regneark</button>
                    </div>`;
            } else {
                container.innerHTML = state.teachers.map(t => {
                    const active = selectedTeachers.has(t.id) ? "selected" : "";
                    return `<span class="t-select-pill ${active}" onclick="toggleActivityTeacher('${t.id}')">${t.name}</span>`;
                }).join("");
            }
        }

        const editingBanner = document.getElementById("editing-activity-banner");
        editingBanner.style.display = editingActivityId ? "flex" : "none";
        document.getElementById("btn-save-activity").textContent = editingActivityId ? "💾 Gem ændringer" : "➕ Gem skolerejse / arrangement";

        const type = document.getElementById("act-type").value;
        const isTrip = type === "school_trip";

        const noSchoolContainer = document.getElementById("act-no-school-container");
        if (noSchoolContainer) {
            noSchoolContainer.style.display = isTrip ? "flex" : "none";
        }

        const box = document.getElementById("act-credits-container");
        const tbody = document.getElementById("act-credits-body");

        if (selectedTeachers.size === 0 || type === "absence") {
            box.style.display = "none";
        } else {
            box.style.display = "block";
            const hdrWknd = document.getElementById("col-hdr-trip-wknd");
            const hdrDay = document.getElementById("col-hdr-trip-day");
            const hdrEvt = document.getElementById("col-hdr-event");
            if (hdrWknd) {
                hdrWknd.style.display = "";
                hdrWknd.textContent = isTrip
                    ? `Rejse-weekendvært (á ${rules.tripHostHours} t)`
                    : `Arr.-weekendvært (á ${rules.weekendHours} t)`;
            }
            if (hdrDay) {
                hdrDay.style.display = "";
                hdrDay.textContent = isTrip
                    ? `Rejse-hverdagsvært (á ${rules.weekdayHours} t)`
                    : `Arr.-hverdagsvært (á ${rules.weekdayHours} t)`;
            }
            if (hdrEvt) hdrEvt.style.display = "none";

            const editingAct = editingActivityId ? state.activities.find(a => a.id === editingActivityId) : null;
            const startVal = document.getElementById("act-start")?.value || "";
            const startDow = startVal ? window.HostPlanner.getDow(startVal) : -1;
            const startsOnWknd = startDow === 0 || startDow === 6;
            const wkndRate = isTrip ? rules.tripHostHours : rules.weekendHours;

            tbody.innerHTML = [...selectedTeachers].map(tId => {
                const existingCr = editingAct?.credits?.find(c => c.teacher === tId);
                let defWknd = existingCr ? (existingCr.tripWeekendHosts || 0) : (isTrip ? 1 : (startsOnWknd ? 1 : 0));
                let defDay = existingCr ? (existingCr.tripDayHosts || 0) : (isTrip ? 1 : (startsOnWknd ? 0 : 1));
                if (existingCr && existingCr.eventHosts > 0 && defWknd === 0 && defDay === 0) {
                    if (startsOnWknd) defWknd = existingCr.eventHosts;
                    else defDay = existingCr.eventHosts;
                }
                const hrs = defWknd * wkndRate + defDay * rules.weekdayHours;

                return `<tr data-teacher="${tId}">
                    <td><strong>${tId}</strong></td>
                    <td><input type="number" class="cr-trip-wknd" min="0" max="10" step="0.5" value="${defWknd}" oninput="recalcCreditRow(this)"></td>
                    <td><input type="number" class="cr-trip-day" min="0" max="10" step="0.5" value="${defDay}" oninput="recalcCreditRow(this)"></td>
                    <td style="display:none"><input type="number" class="cr-evt" value="0"></td>
                    <td class="cr-summary"><strong>${defWknd + defDay}</strong> værtsskab (${hrs} t)</td>
                </tr>`;
            }).join("");
        }

        document.getElementById("activity-count-badge").textContent = state.activities.length;
        const listBody = document.getElementById("activity-list-body");
        if (state.activities.length === 0) {
            listBody.innerHTML = `<tr><td colspan="6" style="color:var(--muted)">Ingen skolerejser eller arrangementsværtsskaber oprettet endnu.</td></tr>`;
            return;
        }

        const typeLabels = { school_trip: "🧳 Skolerejse", event_host: "🎪 Arrangement", absence: "🚫 Fravær" };
        listBody.innerHTML = state.activities.map(act => {
            const progMap = window.HostPlanner.getActivityProgress(state, act);
            let totalReq = 0, totalAssigned = 0;

            const teachersHtml = (act.credits || []).map(c => {
                const p = progMap[c.teacher] || { assignedTotal: 0, reqTotal: 0 };
                totalReq += p.reqTotal;
                totalAssigned += p.assignedTotal;
                const doneBadge = p.reqTotal > 0 ? ` [${p.assignedTotal}/${p.reqTotal}]` : "";
                return `<span class="badge" style="margin:2px; ${p.reqTotal > 0 && p.assignedTotal >= p.reqTotal ? "background:var(--ok-bg);color:var(--ok-text);" : ""}">
                    <strong>${c.teacher}</strong>${doneBadge}
                </span>`;
            }).join(" ");

            const quotaSummary = act.type === "absence"
                ? `<span class="badge">Kun fravær</span>`
                : `<span class="badge ${totalAssigned >= totalReq && totalReq > 0 ? "need-ok" : "need-partial"}">
                    Kvote fordelt: ${totalAssigned} / ${totalReq}
                   </span>`;

            const noSchoolBadge = act.noSchoolHosts
                ? `<span class="badge" style="background:#e0f2fe; color:#0369a1;">✈️ Ingen skoleværter</span>`
                : "";

            const distLabel = act.type === "event_host" ? "✨ Fordel på dage" : "✨ Fordel på rejsedage";
            const autoBtn = act.type !== "absence" && (act.credits || []).length > 0
                ? `<button class="btn btn-primary btn-sm" onclick="autoDistributeActivity(${act.id})">${distLabel}</button>`
                : "";

            const lockStatus = act.calendarLocked
                ? `<span class="badge" style="background:var(--ok-bg);color:var(--ok-text)">🔒 Låst i kalender</span>
                   <button class="btn btn-secondary btn-sm" onclick="unlockTripInCalendar(${act.id})">🔓 Lås op</button>`
                : `<button class="btn btn-secondary btn-sm" onclick="lockTripInCalendar(${act.id})">🔒 Lås i kalender</button>`;

            return `<tr>
                <td>${typeLabels[act.type] || act.type}</td>
                <td>
                    <strong>${act.title}</strong> ${noSchoolBadge}<br>
                    <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:5px;">
                        ${quotaSummary}
                        ${autoBtn}
                        ${lockStatus}
                    </div>
                </td>
                <td>${act.start} → ${act.end}</td>
                <td>± ${act.bufferDays} dage</td>
                <td>${teachersHtml}</td>
                <td>
                    <div style="display:flex; gap:5px;">
                        <button class="btn btn-secondary btn-sm" onclick="editActivity(${act.id})">✏️ Rediger</button>
                        <button class="btn btn-danger btn-sm" onclick="removeActivity(${act.id})">Slet</button>
                    </div>
                </td>
            </tr>`;
        }).join("");
    },

    renderCalendarOverview(state, rules) {
        const grid = document.getElementById("calendar-overview-grid");
        const titleEl = document.getElementById("cal-overview-title");
        const teacherSel = document.getElementById("cal-highlight-teacher");
        const showDetails = document.getElementById("cal-show-details")?.checked ?? true;
        if (!grid) return;

        // Opdater lærer-dropdown uden at miste det aktuelle valg
        if (teacherSel) {
            const currentVal = teacherSel.value || "all";
            teacherSel.innerHTML = `<option value="all">👤 Fremhæv lærer: Vis alle</option>` +
                (state.teachers || []).map(t => `<option value="${t.id}">${t.name} (${Math.round(t.quota * 100)}%)</option>`).join("");
            if ([...teacherSel.options].some(o => o.value === currentVal)) {
                teacherSel.value = currentVal;
            }
        }
        const highlightId = teacherSel ? teacherSel.value : "all";

        const monthNames = [
            "Januar", "Februar", "Marts", "April", "Maj", "Juni",
            "Juli", "August", "September", "Oktober", "November", "December"
        ];
        const dowShort = ["Sø", "Ma", "Ti", "On", "To", "Fr", "Lø"];

        // Find månederne i det aktive semester
        let ymList = [...new Set((state.shifts || []).map(s => s.date.slice(0, 7)))].sort();
        if (ymList.length === 0) {
            ymList = state.semester === "efteraar"
                ? ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]
                : ["2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06"];
        }

        const years = [...new Set(ymList.map(ym => ym.slice(0, 4)))];
        const semLabel = window.APP_SETTINGS?.semesters?.[state.semester]?.label || "";
        if (titleEl) {
            titleEl.textContent = `🗓️ ${semLabel} (${years.join(" / ")})`;
        }

        const shiftMap = new Map((state.shifts || []).map(s => [s.date, s]));
        grid.style.gridTemplateColumns = `repeat(${Math.min(6, Math.max(1, ymList.length))}, minmax(175px, 1fr))`;

        grid.innerHTML = ymList.map(ym => {
            const [yStr, mStr] = ym.split("-");
            const year = parseInt(yStr, 10);
            const monthIdx = parseInt(mStr, 10) - 1;
            const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
            const headerLabel = years.length > 1 ? `${monthNames[monthIdx]} ${yStr.slice(2)}` : monthNames[monthIdx];

            let rowsHtml = "";
            for (let day = 1; day <= 31; day++) {
                if (day > daysInMonth) {
                    rowsHtml += `<div class="cal-row cal-empty"></div>`;
                    continue;
                }

                const dateStr = `${yStr}-${mStr}-${String(day).padStart(2, "0")}`;
                const dow = new Date(year, monthIdx, day, 12, 0, 0).getDay();
                const isWknd = (dow === 0 || dow === 6);
                const shift = shiftMap.get(dateStr);

                const effReq = shift ? window.HostPlanner.getEffectiveReqHosts(state, shift) : 0;
                const schoolHosts = shift ? shift.assigned.slice(0, effReq).filter(Boolean) : [];
                const tripHosts = shift ? (shift.tripSlots || []).map(ts => ts.teacherId).filter(Boolean) : [];
                const allHostsOnDay = [...schoolHosts, ...tripHosts];

                const dayActivities = (state.activities || []).filter(a => a.type !== "absence" && dateStr >= a.start && dateStr <= a.end);

                const rowClasses = ["cal-row"];
                if (isWknd) rowClasses.push("cal-weekend");
                else if (shift && effReq === 0 && tripHosts.length === 0) rowClasses.push("cal-holiday");

                if (highlightId !== "all") {
                    if (allHostsOnDay.includes(highlightId)) rowClasses.push("cal-highlight");
                    else rowClasses.push("cal-dimmed");
                }

                // Indhold i cellen
                let contentHtml = "";
                const parts = [];

                if (effReq > 0) {
                    const missingCount = Math.max(0, effReq - schoolHosts.length);
                    if (schoolHosts.length > 0) {
                        parts.push(schoolHosts.join(", "));
                    }
                    if (missingCount > 0) {
                        parts.push(`<span class="cal-hosts-missing">${schoolHosts.length > 0 ? `+${missingCount} mangler` : `Mangler (${missingCount})`}</span>`);
                    }
                }

                if (showDetails && tripHosts.length > 0) {
                    const tripLabel = dayActivities.length > 0 ? dayActivities[0].title : "Rejse/Arr.";
                    parts.push(`<span class="cal-trip-tag" title="${tripLabel}: ${tripHosts.join(", ")}">🧳 ${tripHosts.join(", ")}</span>`);
                }

                if (showDetails) {
                    const extraText = shift?.event || (dayActivities.length > 0 && effReq === 0 && tripHosts.length === 0 ? dayActivities[0].title : "");
                    if (extraText) {
                        parts.push(`<span class="cal-event-text">${extraText}</span>`);
                    }
                }

                contentHtml = parts.join(" · ");

                const weekHtml = (dow === 1 && shift?.week)
                    ? `<span class="cal-week-num" title="Uge ${shift.week}">${shift.week}</span>`
                    : "";

                const tooltipParts = [`${dateStr} (${dowShort[dow]})`];
                if (shift?.week) tooltipParts.push(`Uge ${shift.week}`);
                if (schoolHosts.length) tooltipParts.push(`Skolevært: ${schoolHosts.join(", ")}`);
                if (tripHosts.length) tooltipParts.push(`Rejse/Arr.: ${tripHosts.join(", ")}`);
                if (shift?.event) tooltipParts.push(shift.event);

                rowsHtml += `
                    <div class="${rowClasses.join(" ")}" onclick="jumpToShiftDate('${dateStr}')" title="${tooltipParts.join(" · ")}">
                        <span class="cal-date-cell">
                            <span class="cal-dow">${dowShort[dow]}</span>
                            <span class="cal-num">${day}</span>
                        </span>
                        <span class="cal-hosts-cell">${contentHtml}</span>
                        ${weekHtml}
                    </div>
                `;
            }

            return `
                <div class="cal-month-col">
                    <div class="cal-month-header">${headerLabel}</div>
                    ${rowsHtml}
                </div>
            `;
        }).join("");
    },

    renderAnalysis(state, rules) {
        const kpiEl = document.getElementById("analysis-kpis");
        const underEl = document.getElementById("analysis-under-norm");
        const friInfoEl = document.getElementById("analysis-friday-info");
        const findingsEl = document.getElementById("analysis-findings");
        const tbody = document.getElementById("analysis-teacher-body");
        const badgeEl = document.getElementById("analysis-issue-badge");
        const showAcked = document.getElementById("toggle-show-acked")?.checked ?? true;
        if (!kpiEl || !findingsEl || !tbody) return;

        const analyzer = window.PlanAnalyzer || window.HostPlanner;
        const report = analyzer.analyzePlan(state, rules);
        const s = report.summary;
        if (badgeEl) badgeEl.textContent = s.issueCount;

        const wishPct = s.totalWishesYes > 0 ? Math.round((s.grantedWishesYes / s.totalWishesYes) * 100) : 100;

        kpiEl.innerHTML = `
            <div class="kpi-card">
                <div class="kpi-label">Norm-præcision</div>
                <div class="kpi-val">${s.withinNormCount} / ${s.totalActiveTeachers} lærere</div>
                <div class="kpi-sub">${(report.underNormPool || []).length} i puljen under norm</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Rejse- & Bufferkonflikter</div>
                <div class="kpi-val" style="color:${s.tripConflictCount > 0 ? "var(--err-text)" : "var(--ok-text)"}">${s.tripConflictCount}</div>
                <div class="kpi-sub">${s.tripConflictCount === 0 ? "✅ Ingen sammenstød med rejser" : "Vagter under rejse eller i buffer"}</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Opfyldte 'o'-ønsker</div>
                <div class="kpi-val">${s.grantedWishesYes} / ${s.totalWishesYes} (${wishPct}%)</div>
                <div class="kpi-sub">${s.wishNoCount === 0 ? "✅ 0 brud på 'x'-ønsker" : `⚠️ ${s.wishNoCount} vagt(er) på 'x'-dage`}</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Ikke-sete fund</div>
                <div class="kpi-val">${s.issueCount} <small style="font-size:13px;font-weight:500;color:var(--muted);">/ ${s.totalFindingCount ?? s.issueCount}</small></div>
                <div class="kpi-sub">Ving af efterhånden som du tjekker</div>
            </div>
        `;

        if (friInfoEl && s.fridaysPerFullTime !== undefined) {
            friInfoEl.textContent = `📅 Fredagskvote: ${s.totalFridaySlots} fredagsvagter ÷ ${s.totalQuota} årsværk ≈ ${s.fridaysPerFullTime} fredage pr. 100%-stilling`;
        }

        if (underEl) {
            const pool = report.underNormPool || [];
            if (pool.length === 0) {
                underEl.innerHTML = `<span style="font-size:13px; color:var(--ok-text);">✅ Alle lærere har nået deres samlede norm.</span>`;
            } else {
                underEl.innerHTML = `<div class="under-norm-pool">
                    ${pool.map(item => `
                        <span class="under-norm-pill">
                            <strong>${item.teacher.name}</strong> (${Math.round(item.teacher.quota * 100)}%)
                            <span>· mangler <strong>${item.missingTotal}</strong></span>
                            <small style="color:var(--muted)">(${item.missingDay} dag, ${item.missingWknd} wknd)</small>
                        </span>
                    `).join("")}
                </div>`;
            }
        }

        const visibleFindings = report.findings.filter(f => showAcked || !f.acknowledged);
        if (visibleFindings.length === 0) {
            findingsEl.innerHTML = `<div style="padding:10px 12px; border-radius:6px; background:var(--ok-bg); color:var(--ok-text); font-size:13px;">
                ✅ Ingen aktive eller ubehandlede advarsler i planen.
            </div>`;
        } else {
            findingsEl.innerHTML = visibleFindings.map(f => {
                const colors = {
                    error: "background:var(--err-bg); color:var(--err-text); border-left:4px solid #dc2626;",
                    warn: "background:var(--warn-bg); color:var(--warn-text); border-left:4px solid #f59e0b;",
                    ok: "background:var(--ok-bg); color:var(--ok-text); border-left:4px solid #16a34a;"
                };
                const icons = { error: "🔴", warn: "🟡", ok: "🟢" };

                let actionsHtml = "";
                const hasSuggs = Array.isArray(f.suggestions) && f.suggestions.length > 0;
                if (hasSuggs || (f.canRemove && f.shiftId)) {
                    actionsHtml += `<div class="finding-actions">`;
                    (f.suggestions || []).forEach(cand => {
                        const poolTag = cand.isUnderNorm ? `mangler ${cand.missingTotal}` : "i norm";
                        const wishTag = cand.isYes ? " · ⭐ ønske" : "";
                        actionsHtml += `<button type="button" class="btn-swap-sugg"
                            onclick="swapHostOnShift('${f.shiftId}', ${f.slotIndex}, '${cand.teacherId}')">
                            🔄 Byt med ${cand.teacherId} (${poolTag}${wishTag})
                        </button>`;
                    });
                    if (f.canRemove && f.shiftId) {
                        actionsHtml += `<button type="button" class="btn-inline-danger" style="padding:4px 9px;"
                            onclick="removeHostFromAnalysis('${f.shiftId}', ${f.slotIndex})">
                            🗑️ Fjern vagt
                        </button>`;
                    }
                    actionsHtml += `</div>`;
                }

                return `<div class="finding-card ${f.acknowledged ? "is-acked" : ""}" style="${colors[f.level]}">
                    <input type="checkbox" class="finding-ack-box" ${f.acknowledged ? "checked" : ""}
                        onchange="toggleFindingAck('${f.id}')" title="Marker som set / godkendt">
                    <div class="finding-body">
                        <div class="finding-title"><strong>${icons[f.level]} [${f.category}] ${f.title}</strong></div>
                        <div style="font-size:12px; opacity:0.9; margin-top:2px;">${f.detail}</div>
                        ${actionsHtml}
                    </div>
                </div>`;
            }).join("");
        }

        tbody.innerHTML = report.teacherRows.map(row => {
            const t = row.teacher;
            const st = row.stats;
            const wkndProfileTxt = st.weekendShifts > 0
                ? `${row.wkndACount ?? 0} 'a' / ${row.otherWkndCount ?? 0} øvrige`
                : "0 weekender";

            const normTxt = row.quotaDiff === 0
                ? `<span class="badge need-ok">0 (i mål)</span>`
                : (row.quotaDiff > 0
                    ? `<span class="badge ${row.quotaDiff >= 0.9 ? "need-empty" : "need-partial"}">+${row.quotaDiff}</span>`
                    : `<span class="badge">${row.quotaDiff}</span>`);

            const gapTxt = row.minSeparateGap === null
                ? "—"
                : (row.minSeparateGap < rules.minRestDaysBetweenShifts
                    ? `<span style="color:var(--err-text); font-weight:700;">⚠️ ${row.minSeparateGap} dage</span>`
                    : `${row.minSeparateGap} dage`);

            const statusNotes = [];
            row.tripIssues.forEach(item => statusNotes.push(`🔴 ${item.msg || item}`));
            row.tWishNoDates.forEach(d => statusNotes.push(`🔴 Sat på 'x' (${d})`));
            if (row.clusterAlert) statusNotes.push(`🟡 ${row.clusterAlert}`);

            return `<tr>
                <td><strong>${t.name}</strong> <small style="color:var(--muted)">(${Math.round(t.quota * 100)}%)</small></td>
                <td>${st.totalShifts} / ${t.targetTotal} ${normTxt}</td>
                <td><strong>${st.fridayShifts}</strong> / ${st.targetFridays}</td>
                <td>${gapTxt}</td>
                <td>${row.avgGap !== null ? `${row.avgGap} dage` : "—"}</td>
                <td>${wkndProfileTxt}</td>
                <td>${row.tWishYesTotal > 0 ? `${row.tWishYesGranted} / ${row.tWishYesTotal}` : "—"}</td>
                <td style="font-size:12px;">${statusNotes.length ? statusNotes.join("<br>") : "✅ Ingen anmærkninger"}</td>
            </tr>`;
        }).join("");
    },

    renderConfig(state, rules) {
        document.getElementById("config-sem-label").textContent = window.APP_SETTINGS.semesters[state.semester].label;
        document.getElementById("rule-weekday-hrs").value = rules.weekdayHours;
        document.getElementById("rule-weekend-hrs").value = rules.weekendHours;
        document.getElementById("rule-trip-hrs").value = rules.tripHostHours;
        document.getElementById("rule-event-hrs").value = rules.eventHostHours;
        document.getElementById("rule-rest-days").value = rules.minRestDaysBetweenShifts;
        document.getElementById("rule-trip-buffer").value = rules.defaultTripBufferDays;

        const compactActivities = window.compactActivitiesForJson
            ? window.compactActivitiesForJson(state.activities, rules)
            : state.activities;
        document.getElementById("activities-json-editor").value = JSON.stringify(compactActivities, null, 2);

        const exportPreview = window.buildExportPayload
            ? window.buildExportPayload(state, rules)
            : state;
        document.getElementById("json-preview").value = JSON.stringify(exportPreview, null, 2);
    }
};