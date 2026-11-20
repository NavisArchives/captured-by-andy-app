//! The morning brief: what needs Andy today across photos, posts, money and
//! the Mac, gathered in one call for the Dashboard's "Today" list.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::app::{blocking, AppState};
use crate::library::{cleanup, db::Db};

type Reply<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoice {
    pub id: String,
    pub client: String,
    pub campaign: String,
    pub amount: Option<f64>,
    pub currency: Option<String>,
    pub fee: String,
    /// When it went out ("2026-09-10"), if known.
    pub sent_date: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    /// Rejected photos that are near-copies of a kept one: safe to clean up.
    pub cleanup_copies: usize,
    pub cleanup_copies_bytes: i64,
    pub cleanup_bytes: i64,
    /// Posts that are ready but have no date yet.
    pub posts_ready: i64,
    /// New inspiration saves not looked at yet.
    pub saves_inbox: i64,
    pub unpaid: Vec<Invoice>,
    /// Free space on the disk the library is on (None when it can't be read).
    pub disk_free: Option<u64>,
    /// Open decisions on the agency board (OFFICE/NIRMATA/STATUS.md): "D1 Brand via agency…".
    pub decisions: Vec<String>,
}

/// The agency board NIRMATA keeps (OFFICE/NIRMATA/STATUS.md; the older
/// OFFICE/MOTHER path as a fallback); the brief only reads it.
fn board_file() -> std::path::PathBuf {
    let office = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default().join("Movies/OFFICE");
    let board = office.join("NIRMATA/STATUS.md");
    if board.is_file() {
        board
    } else {
        office.join("MOTHER/STATUS.md")
    }
}

/// "| D1 | Brand via agency: … | why | advice |" rows under "Decisions only Andy can make".
fn open_decisions(board: &str) -> Vec<String> {
    let mut inside = false;
    let mut out = Vec::new();
    for line in board.lines() {
        if line.starts_with("## ") {
            inside = line.to_lowercase().contains("decisions only andy");
            continue;
        }
        if !inside || !line.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
        if cells.len() >= 2 && cells[0].starts_with('D') && cells[0][1..].chars().all(|c| c.is_ascii_digit()) && cells[0].len() > 1 {
            out.push(format!("{} {}", cells[0], cells[1]));
        }
    }
    out
}

/// Opens the agency board (that one file) in its usual app.
#[tauri::command]
pub async fn open_agency_board() -> Reply<()> {
    let f = board_file();
    if !f.is_file() {
        return Err("The agency board isn't there (OFFICE/NIRMATA/STATUS.md).".into());
    }
    std::process::Command::new("/usr/bin/open").arg(f).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// Free bytes on the volume holding `path`, from `df` (no extra dependency).
fn free_space(path: &std::path::Path) -> Option<u64> {
    let out = std::process::Command::new("/bin/df").arg("-k").arg(path).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1)?;
    line.split_whitespace().nth(3)?.parse::<u64>().ok().map(|k| k * 1024)
}

fn gather(db: &Db, library: &std::path::Path) -> crate::library::Result<Brief> {
    let o = cleanup::overview(db, &crate::cleanup_cmd::website_ids(db))?;
    let (posts_ready, saves_inbox, unpaid) = db.read(|c| {
        let n = |sql: &str| -> rusqlite::Result<i64> { c.query_row(sql, [], |r| r.get(0)) };
        let mut st = c.prepare(
            "SELECT id, client, campaign, amount, currency, fee, invoice_sent_date FROM studio_brand_jobs
             WHERE invoice_status = 'sent' ORDER BY COALESCE(invoice_sent_date, '0000'), client",
        )?;
        let unpaid = st
            .query_map([], |r| {
                Ok(Invoice {
                    id: r.get(0)?,
                    client: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    campaign: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    amount: r.get(3)?,
                    currency: r.get(4)?,
                    fee: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    sent_date: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((
            n("SELECT COUNT(*) FROM posts WHERE status = 'ready' AND scheduled_at IS NULL")?,
            n("SELECT COUNT(*) FROM studio_saves WHERE status = 'inbox'")?,
            unpaid,
        ))
    })?;
    Ok(Brief {
        cleanup_copies: o.trips.iter().map(|t| t.copies).sum(),
        cleanup_copies_bytes: o.trips.iter().map(|t| t.bytes_copies).sum(),
        cleanup_bytes: o.trips.iter().map(|t| t.bytes).sum(),
        posts_ready,
        saves_inbox,
        unpaid,
        disk_free: free_space(library),
        decisions: std::fs::read_to_string(board_file()).map(|t| open_decisions(&t)).unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn morning_brief(app: AppHandle) -> Reply<Brief> {
    blocking(move || {
        let state = app.state::<AppState>();
        let library = crate::library::offline::library_dir(&state.db).unwrap_or_else(|_| state.cache.root().to_path_buf());
        gather(&state.db, &library)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_open_decisions_off_the_board() {
        let board = "# Board\n\n## Decisions only Andy can make (open)\n| # | Decision | Why |\n|---|---|---|\n| D1 | Brand via agency: accept? | cash |\n| D2 | Rate card numbers | blocks |\n\n## Roles\n| D9 | not a decision | x |\n";
        assert_eq!(open_decisions(board), ["D1 Brand via agency: accept?", "D2 Rate card numbers"]);
        assert!(open_decisions("nothing here").is_empty());
    }
}
