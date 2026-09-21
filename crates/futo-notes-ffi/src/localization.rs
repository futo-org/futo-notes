use icu_locale::{Locale, LocaleExpander};
use icu_plurals::{PluralCategory, PluralRules};

#[uniffi::export]
pub fn localization_maximize_language_tag(language_tag: String) -> Option<String> {
    let mut locale = language_tag.parse::<Locale>().ok()?;
    LocaleExpander::new_extended().maximize(&mut locale.id);
    Some(locale.id.to_string())
}

#[uniffi::export]
pub fn localization_plural_category(language_tag: String, value: u64) -> String {
    let Ok(locale) = language_tag.parse::<Locale>() else {
        return "other".to_string();
    };
    let Ok(rules) = PluralRules::try_new_cardinal(locale.into()) else {
        return "other".to_string();
    };
    match rules.category_for(value) {
        PluralCategory::Zero => "zero",
        PluralCategory::One => "one",
        PluralCategory::Two => "two",
        PluralCategory::Few => "few",
        PluralCategory::Many => "many",
        PluralCategory::Other => "other",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::{localization_maximize_language_tag, localization_plural_category};

    #[test]
    fn maximizes_simplified_and_traditional_chinese_without_crossing_scripts() {
        assert_eq!(
            localization_maximize_language_tag("zh-CN".to_string()).as_deref(),
            Some("zh-Hans-CN")
        );
        assert_eq!(
            localization_maximize_language_tag("zh-TW".to_string()).as_deref(),
            Some("zh-Hant-TW")
        );
    }

    #[test]
    fn selects_cardinal_plural_categories() {
        assert_eq!(localization_plural_category("en".to_string(), 1), "one");
        assert_eq!(localization_plural_category("en".to_string(), 2), "other");
        assert_eq!(localization_plural_category("ar".to_string(), 3), "few");
    }
}
