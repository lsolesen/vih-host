window.APP_SETTINGS = {
    appTitle: "Værtsplanlægger",
    defaultSemester: "efteraar", // "efteraar" eller "foraar"

    semesters: {
        efteraar: {
            label: "Efterår (E2026)",
            googleSheetCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRRfoAmSRkl8YRmnR2FgwqnTlqYLSH2WkIfEacXovuWA4Jsta1wQ3f9J3YOogn0RrwVJd8Q6h7d7cMn/pub?gid=481169562&single=true&output=csv",
            defaultJsonPath: "./data/efteraar.json",
            rules: {
                weekdayHours: 7,
                weekendHours: 12,
                tripHostHours: 12,
                eventHostHours: 7,
                fullTimeTargetHours: 128,
                fullTimeDayShifts: 9,
                fullTimeWeekendShifts: 5,
                minRestDaysBetweenShifts: 5,
                defaultTripBufferDays: 7
            },
            presetActivities: []
        },
        foraar: {
            label: "Forår (F2027)",
            googleSheetCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRRfoAmSRkl8YRmnR2FgwqnTlqYLSH2WkIfEacXovuWA4Jsta1wQ3f9J3YOogn0RrwVJd8Q6h7d7cMn/pub?gid=350941673&single=true&output=csv",
            defaultJsonPath: "./data/foraar.json",
            rules: {
                weekdayHours: 7,
                weekendHours: 12,
                tripHostHours: 12,
                eventHostHours: 7,
                fullTimeTargetHours: 147,
                fullTimeDayShifts: 10,
                fullTimeWeekendShifts: 6,
                minRestDaysBetweenShifts: 5,
                defaultTripBufferDays: 7
            },
            presetActivities: []
        }
    },

    // Kategorier til weekender og fredage (kolonnen lige efter 'w' i regnearket)
    shiftCategories: {
        r: { label: "Restitution", short: "r", colorClass: "cat-rest" },
        a: { label: "Aktivitet", short: "a", colorClass: "cat-act" },
        "å": { label: "Åben / Café", short: "å", colorClass: "cat-open" }
    },

    eventHoursOverrides: {
        "Fest": 12,
        "Gallafest": 12,
        "Introfest": 12,
        "Cafe": 8
    },

    externalHostCodes: ["UNG"],

    csvMapping: {
        lockSheetAssignments: true,
        quotaRowLabel: "Kvote for semester",
        dayNormRowLabel: "Dagvært norm",
        weekendNormRowLabel: "Weekendvært norm",
        totalNormRowLabel: "I alt værtskabsdage norm",
        poolHoursRowLabel: "Værtskabspulje",
        calendarHeaderFirstCol: "Uge",
        dateColHeader: "Dato",
        weekdayColHeader: "Dag",
        assignedColHeader: "Vært",
        eveningHostColHeader: "Aftenvært",
        countColHeader: "Antal",
        eventColHeader: "Viggokalender",
        weekendMarker: "w",
        wishNo: ["x", "rejse", "ferie", "kursus"],
        wishYes: ["o"]
    }
};