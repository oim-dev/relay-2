/**
 * Bash-транспорт протокола Gunshi: сохраняет границы слов и не исполняет введённый текст через eval.
 * bash-completion предоставляет _get_comp_words_by_ref; кандидаты уже отфильтрованы плагином.
 * Используется команда из PATH, поэтому обычная замена бинарника не требует нового скрипта.
 */
export const bashCompletionScript = `# Автодополнение Relay для Bash; требуется bash-completion.
__relay_complete() {
    local cur prev words cword
    local out value description
    COMPREPLY=()
    _get_comp_words_by_ref -n '=:' cur prev words cword || return 0
    (( cword >= 1 )) || return 0

    local -a request=("\${words[@]:1:cword-1}" "$cur")
    out=$(command relay complete -- "\${request[@]}" 2>/dev/null) || return 0

    while IFS=$'\\t' read -r value description; do
        # Плагин завершает ответ директивой :4 (без файлового fallback).
        [[ "$value" == :* || -z "$value" ]] && continue
        COMPREPLY+=("$value")
    done <<< "$out"
}
complete -F __relay_complete relay
`;
