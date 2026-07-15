//! Обрезка строк по границе символа.
//!
//! `String::truncate`/`&s[..n]` паникуют, если байт `n` попал внутрь
//! многобайтового символа. Стримеры (stderr агента, лог обновления, вывод
//! dev-сервера) режут произвольный UTF-8 — кириллица и эмодзи там норма, так
//! что паника — вопрос времени, а в stdout-ридере супервизора она рвёт весь
//! поток RPC-событий: pi жив, а UI выглядит зависшим.

/// Ближайшая граница символа на позиции `max` или левее.
fn floor_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Обрезать до `max` байт, не разрывая символ.
pub fn truncate_bytes(s: &mut String, max: usize) {
    let end = floor_boundary(s, max);
    s.truncate(end);
}

/// Префикс не длиннее `max` байт, не разрывающий символ.
pub fn head_bytes(s: &str, max: usize) -> &str {
    &s[..floor_boundary(s, max)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_ascii_exactly() {
        let mut s = "hello world".to_string();
        truncate_bytes(&mut s, 5);
        assert_eq!(s, "hello");
    }

    #[test]
    fn never_splits_a_multibyte_char() {
        // Кириллица — 2 байта на символ: байт 5 попадает внутрь «и»
        // (байты 4–5), поэтому режем по ближайшей границе слева — 4.
        let mut s = "ошибка".to_string();
        truncate_bytes(&mut s, 5);
        assert_eq!(s, "ош");
        assert!(s.len() <= 5);
    }

    #[test]
    fn handles_emoji_and_short_limits() {
        let mut s = "🔥🔥".to_string(); // 4 байта каждый
        truncate_bytes(&mut s, 5);
        assert_eq!(s, "🔥");

        let mut s = "🔥".to_string();
        truncate_bytes(&mut s, 1);
        assert_eq!(s, "");
    }

    #[test]
    fn limit_past_end_keeps_everything() {
        let mut s = "короткая строка".to_string();
        truncate_bytes(&mut s, 4000);
        assert_eq!(s, "короткая строка");
        assert_eq!(head_bytes("короткая строка", 4000), "короткая строка");
    }

    #[test]
    fn head_matches_truncate() {
        let src = "неразобранная строка от агента";
        for max in 0..=src.len() + 3 {
            let mut owned = src.to_string();
            truncate_bytes(&mut owned, max);
            assert_eq!(head_bytes(src, max), owned.as_str());
        }
    }
}
