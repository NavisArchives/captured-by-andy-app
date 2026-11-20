pub mod library;
use tauri::Manager;
mod app;
mod applog;
mod archive_cmd;
pub mod assistant_cmd;
pub mod transcripts_cmd;
mod brief_cmd;
mod cleanup_cmd;
mod places_cmd;
mod dictate;
mod editor_package_cmd;
mod studio_cmd;
mod voice;

/// Only the app itself may load in the window. A file dropped from Finder that
/// slips past the page's drop handling would otherwise replace it with
/// file:///…, and the only way back would be to quit.
fn navigation_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        // The dev server (devUrl http://localhost:1420), and the app on Windows.
        "http" | "https" => matches!(url.host_str(), Some("localhost") | Some("tauri.localhost")),
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(voice::VoiceState::default())
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("nav-guard").on_navigation(|_webview, url| navigation_allowed(url)).build())
        .setup(|app| {
            if let Ok(dir) = app.path().app_log_dir() {
                applog::init(dir);
            }
            applog::line(&format!("launch, version {}", app.package_info().version));
            // A library that can't open is shown with a way out, never a silent quit.
            if let Err(e) = app::setup(app) {
                app::startup_failed(app, e.as_ref());
                return Ok(());
            }
            voice::startup(app.handle());
            studio_cmd::startup(app.handle());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("cba", app::protocol)
        .invoke_handler(tauri::generate_handler![
            app::library_info, app::list_sources, app::add_source, app::set_source_enabled, app::remove_source,
            app::scan_all, app::cancel_scan, app::scan_status, app::sync_status, app::sync_now, app::refresh_analysis,
            app::photo_counts, app::photo_folders, app::smart_counts, app::list_photos, app::photo_ids, app::photo_position, app::photo_neighbor, app::photos_in_view, app::review_marks, app::restore_marks, app::photo_detail, app::photo_burst,
            app::photo_rows, app::set_review,
            app::list_albums, app::create_album, app::update_album, app::delete_album, app::album_add, app::album_remove, app::move_to_trip, app::add_items, app::edited_ids, app::rename_photos, app::warm_previews, app::undo_trip_move, app::misplaced, app::video_trim, app::set_video_trim, app::edit_copy,
            app::list_tags, app::tag_photos, app::untag_photos, app::rename_tag, app::delete_tag,
            app::list_accounts, app::create_account, app::update_account, app::delete_account,
            app::list_posts, app::get_post, app::create_post, app::update_post, app::delete_post, app::trash_list, app::trash_restore, app::trash_purge, app::audit_lines,
            app::post_add_photos, app::post_remove_photos, app::post_reorder, app::post_pipeline, app::account_grid,
            app::plan_posts, app::dashboard,
            app::finder_sync_all, app::finder_remove_added, app::offline_info, app::offline_keep, app::offline_release,
            app::list_locations, app::add_location, app::remove_location, app::archive_photos,
            app::import_looks, app::add_look_folder, app::list_looks, app::delete_look, app::save_look, app::set_look_favorites,
            app::photo_look, app::photo_looks, app::album_look, app::set_album_look, app::change_album_look, app::apply_look, app::auto_adjust, app::export_image,
            app::export_video,
            app::startup_problem,
            app::safe_backups,
            app::safe_restore,
            app::safe_reveal,
            app::log_page_error,
            app::export_diagnostics,
            app::airdrop,
            app::video_moments,
            app::frame_hints,
            app::photo_labels, app::list_labels,
            app::save_video_still,
            app::export_clip,
            app::video_info,
            app::save_original,
            app::keep_videos_local,
            app::add_video_moment,
            app::remove_video_moment,
            app::preview_space,
            app::clear_previews,
            app::look_folders,
            app::remove_look_folder,
            app::list_backups,
            app::backup_now,
            app::restore_backup,
            app::restore_note,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_pause,
            voice::voice_status,
            voice::voice_trace,
            voice::voice_open_settings, app::reveal, app::open_link,
            app::get_setting, app::set_setting,
            app::review_copies, app::make_review_copies, app::want_preview, app::unwant_preview, app::review_copy_exists, app::prepare_cull_plan, app::ui_log, app::view_in_source, app::stop_review_copies, app::download_plan, app::download_status, app::download_originals, app::stop_download, app::remove_downloads, app::videos_ready, app::gdrive_status, app::gdrive_reconnect, app::gdrive_connect, app::gdrive_disconnect, app::gdrive_speed_test, app::gdrive_find_client,
            studio_cmd::studio_list, studio_cmd::studio_get, studio_cmd::studio_save, studio_cmd::studio_delete,
            studio_cmd::studio_link, studio_cmd::studio_linked, studio_cmd::studio_root, studio_cmd::studio_summary,
            studio_cmd::studio_greenlight, studio_cmd::studio_piece_folder, studio_cmd::studio_family_folder, studio_cmd::studio_set_stage,
            studio_cmd::studio_park_stale, studio_cmd::studio_add_link, studio_cmd::studio_add_paths, studio_cmd::studio_add_bytes,
            studio_cmd::studio_ingest, studio_cmd::studio_import_knowledge, studio_cmd::studio_refresh_preview, studio_cmd::studio_import, studio_cmd::studio_trends,
            studio_cmd::studio_youtube, studio_cmd::studio_watch_check, studio_cmd::studio_similar, studio_cmd::studio_write_plan,
            studio_cmd::studio_mark_posted, studio_cmd::studio_check_export, studio_cmd::studio_open_capcut, studio_cmd::studio_open_folder,
            studio_cmd::studio_pending_captures, studio_cmd::studio_read_plan, studio_cmd::studio_piece_files, studio_cmd::studio_read_fcpxml, studio_cmd::studio_open_in_final_cut,
            brief_cmd::morning_brief, brief_cmd::open_agency_board, places_cmd::trip_places, places_cmd::make_places, cleanup_cmd::cleanup_overview, cleanup_cmd::cleanup_photos, cleanup_cmd::cleanup_mark, cleanup_cmd::cleanup_mark_set, cleanup_cmd::cleanup_delete, cleanup_cmd::cleanup_history, cleanup_cmd::cleanup_undo, cleanup_cmd::cleanup_phone_find, cleanup_cmd::cleanup_phone_delete,
            assistant_cmd::assistant_status, assistant_cmd::assistant_send,
            transcripts_cmd::transcripts_start, transcripts_cmd::transcripts_status, transcripts_cmd::transcripts_playing, transcripts_cmd::video_transcript, transcripts_cmd::set_transcript_lines, transcripts_cmd::transcribe_video,
            archive_cmd::archive_read, archive_cmd::archive_write, archive_cmd::archive_write_image, archive_cmd::archive_write_clip, archive_cmd::archive_frame_status, archive_cmd::site_read, archive_cmd::site_write, archive_cmd::site_put_logo, archive_cmd::archive_sync, archive_cmd::archive_album_photos, archive_cmd::archive_preview,
            editor_package_cmd::studio_editor_plan, editor_package_cmd::studio_editor_status, editor_package_cmd::studio_editor_prepare, editor_package_cmd::studio_editor_cancel,
            dictate::dictate_start, dictate::dictate_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building Captured by Andy")
        .run(|app, event| {
            // "Save to Studio" from the browser or a Shortcut: capturedbyandy://save?url=…
            if let tauri::RunEvent::Opened { urls } = event {
                studio_cmd::opened(app, urls);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::navigation_allowed;

    fn allowed(url: &str) -> bool {
        navigation_allowed(&url.parse().unwrap())
    }

    #[test]
    fn the_app_and_the_dev_server_may_load() {
        assert!(allowed("tauri://localhost"));
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("http://localhost:1420/"));
        assert!(allowed("http://tauri.localhost/"));
        assert!(allowed("about:blank"));
    }

    #[test]
    fn dropped_files_and_other_sites_are_refused() {
        assert!(!allowed("file:///Volumes/Photos/DSC01234.JPG"));
        assert!(!allowed("file:///Volumes/KINGSTON/Lisbon/"));
        assert!(!allowed("https://www.instagram.com/"));
        assert!(!allowed("http://localhost.example.com/"));
        assert!(!allowed("cba://localhost/thumb/abc"));
    }
}
