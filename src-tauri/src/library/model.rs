use serde::{Deserialize, Serialize};

use super::{Error, Result};

macro_rules! text_enum {
    ($name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $text)] $variant),+ }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
            pub fn parse(text: &str) -> Result<Self> {
                match text {
                    $($text => Ok(Self::$variant),)+
                    other => Err(Error::Invalid(format!(concat!("unknown ", stringify!($name), ": {}"), other))),
                }
            }
        }
    };
}

text_enum!(ReviewState { Unreviewed = "unreviewed", Selected = "selected", Maybe = "maybe", Rejected = "rejected" });
text_enum!(StorageState {
    Local = "local",
    CloudOnly = "cloud_only",
    Missing = "missing",
    Downloading = "downloading",
    AvailableOffline = "available_offline",
});
text_enum!(MediaKind { Raw = "raw", Image = "image", RawImage = "raw_image" });
text_enum!(ThumbState { Pending = "pending", Ready = "ready", Failed = "failed", Unavailable = "unavailable" });

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Jpeg,
    Png,
    Heic,
    Webp,
    Cr2,
    Cr3,
    Arw,
    Nef,
    Dng,
    Mp4,
    Mov,
}

impl Format {
    pub fn from_extension(ext: &str) -> Option<Self> {
        Some(match ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => Self::Jpeg,
            "png" => Self::Png,
            "heic" | "heif" => Self::Heic,
            "webp" => Self::Webp,
            "cr2" => Self::Cr2,
            "cr3" => Self::Cr3,
            "arw" => Self::Arw,
            "nef" => Self::Nef,
            "dng" => Self::Dng,
            "mp4" | "m4v" => Self::Mp4,
            "mov" => Self::Mov,
            _ => return None,
        })
    }

    pub fn is_raw(self) -> bool {
        matches!(self, Self::Cr2 | Self::Cr3 | Self::Arw | Self::Nef | Self::Dng)
    }

    pub fn is_video(self) -> bool {
        matches!(self, Self::Mp4 | Self::Mov)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
            Self::Heic => "heic",
            Self::Webp => "webp",
            Self::Cr2 => "cr2",
            Self::Cr3 => "cr3",
            Self::Arw => "arw",
            Self::Nef => "nef",
            Self::Dng => "dng",
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
        }
    }
}

/// What ImageIO could read from a file's headers. Every field is optional:
/// screenshots have no camera, phones strip GPS, fake RAWs in tests have nothing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Metadata {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub orientation: Option<i64>,
    /// EXIF DateTimeOriginal as local wall-clock text, `YYYY-MM-DDTHH:MM:SS.mmm`.
    pub captured_at: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}
