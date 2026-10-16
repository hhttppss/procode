#!/bin/bash
# Проверка состояния сервера ПроКод, запускается раз в минуту через
# procode-monitor.timer от отдельного пользователя procode-monitor (без root).
#
# Тревоги идут в Telegram с гистерезисом: пока показатель плохой — не спамим
# повторно (state-файл держит ALERT), а «восстановилось» шлём только после
# RECOVERY_STREAK подряд успешных проверок (streak-файл), чтобы не дребезжать
# на границе порога.
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="/opt/monitoring/state"
LOG_FILE="/var/log/procode-monitor.log"
ENV_FILE="/opt/monitoring/monitor.env"
LOCK_FILE="$STATE_DIR/.lock"

mkdir -p "$STATE_DIR"

# Не даём двум запускам наложиться друг на друга, если curl к /healthz завис
# дольше минуты — иначе процессы монитора будут копиться.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date '+%F %T') предыдущий запуск ещё не закончился — пропускаю" >>"$LOG_FILE"
  exit 0
fi

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

MEM_AVAIL_MB_MIN="${MEM_AVAIL_MB_MIN:-200}"
DISK_PCT_MAX="${DISK_PCT_MAX:-85}"
LOAD_MULT="${LOAD_MULT:-1.5}"
SYNRECV_MAX="${SYNRECV_MAX:-30}"
RECOVERY_STREAK="${RECOVERY_STREAK:-3}"
HEALTHZ_URL="${HEALTHZ_URL:-http://127.0.0.1:3000/healthz}"

log() {
  echo "$(date '+%F %T') $*" >>"$LOG_FILE"
}

send_telegram() {
  local text="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    log "Telegram не настроен (нет токена/chat_id) — сообщение не отправлено: $text"
    return 1
  fi
  if ! curl -fsS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" >/dev/null 2>>"$LOG_FILE"; then
    log "ОШИБКА: не удалось отправить сообщение в Telegram"
  fi
}

# ------------------------------------------------------- гистерезис тревог

# $1 ключ  $2 1=плохо/0=норма  $3 текст тревоги  $4 текст восстановления
stateful_check() {
  local key="$1" bad="$2" alert_msg="$3" ok_msg="$4"
  local state_file="$STATE_DIR/${key}.state"
  local streak_file="$STATE_DIR/${key}.streak"
  local state="OK"
  [ -f "$state_file" ] && state="$(cat "$state_file")"

  if [ "$bad" = "1" ]; then
    echo 0 >"$streak_file"
    if [ "$state" != "ALERT" ]; then
      send_telegram "$alert_msg"
      echo "ALERT" >"$state_file"
      log "ТРЕВОГА [$key]: $alert_msg"
    fi
  else
    if [ "$state" = "ALERT" ]; then
      local streak=0
      [ -f "$streak_file" ] && streak="$(cat "$streak_file")"
      streak=$((streak + 1))
      echo "$streak" >"$streak_file"
      if [ "$streak" -ge "$RECOVERY_STREAK" ]; then
        send_telegram "$ok_msg"
        echo "OK" >"$state_file"
        echo 0 >"$streak_file"
        log "ВОССТАНОВЛЕНО [$key]"
      fi
    fi
  fi
}

# --------------------------------------------------------------- проверки

check_service() {
  local unit="$1" label="$2"
  if systemctl is-active --quiet "$unit"; then
    stateful_check "svc_${unit}" 0 "" \
      "✅ ${label} снова работает (${unit})."
  else
    stateful_check "svc_${unit}" 1 \
"🔴 ${label} не работает: служба ${unit} остановлена или упала.
Чем грозит: пока служба лежит, эта часть сайта недоступна посетителям. Проверить: systemctl status ${unit}" \
      ""
  fi
}

check_healthz() {
  local code
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$HEALTHZ_URL" 2>>"$LOG_FILE")"
  if [ "$code" = "200" ]; then
    stateful_check "healthz" 0 "" "✅ Сайт и база снова отвечают на /healthz."
  else
    stateful_check "healthz" 1 \
"🔴 /healthz не отвечает 200 (получен код: ${code:-нет ответа}).
Чем грозит: сайт для посетителей либо не открывается, либо база данных недоступна — заявки и вход в CRM не работают." \
      ""
  fi
}

check_mem() {
  local avail_mb
  avail_mb="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)"
  if [ "$avail_mb" -lt "$MEM_AVAIL_MB_MIN" ]; then
    stateful_check "mem" 1 \
"🟠 Мало свободной памяти: ${avail_mb} МБ доступно (порог ${MEM_AVAIL_MB_MIN} МБ).
Чем грозит: при дальнейшем росте ядро начнёт убивать процессы (OOM), сайт может упасть или зависнуть." \
      ""
  else
    stateful_check "mem" 0 "" "✅ Память вернулась в норму: ${avail_mb} МБ доступно."
  fi
}

check_disk() {
  local pct
  pct="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
  if [ "$pct" -ge "$DISK_PCT_MAX" ]; then
    stateful_check "disk" 1 \
"🟠 Диск заполнен на ${pct}% (порог ${DISK_PCT_MAX}%).
Чем грозит: когда место кончится, перестанут писаться база, логи и бэкапы — сайт может начать отказывать в записи." \
      ""
  else
    stateful_check "disk" 0 "" "✅ Место на диске снова в норме: занято ${pct}%."
  fi
}

check_load() {
  local cores load1 limit bad
  cores="$(nproc)"
  load1="$(awk '{print $1}' /proc/loadavg)"
  limit="$(awk -v c="$cores" -v m="$LOAD_MULT" 'BEGIN { printf "%.2f", c*m }')"
  bad="$(awk -v l="$load1" -v lim="$limit" 'BEGIN { print (l > lim) ? 1 : 0 }')"
  if [ "$bad" = "1" ]; then
    stateful_check "load" 1 \
"🟠 Высокая нагрузка на CPU: load average ${load1} при ${cores} ядрах (порог ${limit}).
Чем грозит: сервер не успевает обрабатывать запросы вовремя, сайт может подтормаживать или не отвечать." \
      ""
  else
    stateful_check "load" 0 "" "✅ Нагрузка на CPU вернулась в норму: load average ${load1}."
  fi
}

check_synrecv() {
  local count
  count="$(ss -tan state syn-recv 2>/dev/null | wc -l)"
  if [ "$count" -gt "$SYNRECV_MAX" ]; then
    stateful_check "synrecv" 1 \
"🔴 Много полуоткрытых TCP-соединений: ${count} в состоянии SYN_RECV (порог ${SYNRECV_MAX}).
Чем грозит: похоже на SYN-flood атаку — сервер может исчерпать ресурсы на обработку соединений и перестать пускать реальных посетителей." \
      ""
  else
    stateful_check "synrecv" 0 "" "✅ Число полуоткрытых соединений вернулось в норму (${count})."
  fi
}

# ------------------------------------------------- разовые события (не тревоги-состояния)

check_ssh_logins() {
  local out
  out="$(journalctl -u ssh --cursor-file="$STATE_DIR/ssh.cursor" -q --no-pager -g 'Accepted (publickey|password) for' 2>>"$LOG_FILE")"
  [ -z "$out" ] && return 0

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local method user ip key
    method="$(echo "$line" | grep -oP 'Accepted \K\w+')"
    user="$(echo "$line" | grep -oP 'for \K\S+')"
    ip="$(echo "$line" | grep -oP 'from \K[0-9a-fA-F:.]+')"
    key="$(echo "$line" | grep -oP 'ssh2: \K.*' || true)"

    if [ "$method" = "password" ]; then
      send_telegram "🔴 SSH-вход по ПАРОЛЮ: пользователь ${user} с ${ip}.
Чем грозит: парольный вход должен быть отключён — если это не вы, ключи и пароли могли утечь. Проверьте /etc/ssh/sshd_config."
    else
      send_telegram "🔑 SSH-вход: пользователь ${user} с ${ip} (${key:-ключ не распознан}).
Информационно — если это не вы или не ожидаемый деплой, это повод проверить сервер."
    fi
    log "SSH-вход: $line"
  done <<<"$out"
}

check_oom() {
  local out
  out="$(journalctl -k --cursor-file="$STATE_DIR/oom.cursor" -q --no-pager -g 'Out of memory|Killed process' 2>>"$LOG_FILE")"
  [ -z "$out" ] && return 0

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    send_telegram "🔴 Ядро убило процесс из-за нехватки памяти (OOM): ${line}
Чем грозит: убитый процесс (возможно, сам сайт) внезапно остановился и мог не подняться сам — проверьте systemctl status procode."
    log "OOM: $line"
  done <<<"$out"
}

check_audit() {
  command -v ausearch >/dev/null 2>&1 || return 0

  local ts_file="$STATE_DIR/audit_last_ts"
  local now from
  now="$(date +%s)"
  if [ -f "$ts_file" ]; then
    from="$(date -d "@$(cat "$ts_file")" +'%m/%d/%Y %H:%M:%S')"
  else
    from="$(date -d '@'"$((now - 60))" +'%m/%d/%Y %H:%M:%S')"
  fi

  local -A KEY_MEANING=(
    [procode_code]="изменён файл кода сайта"
    [procode_secrets]="изменён файл с секретами (.env)"
    [ssh_config]="изменена конфигурация SSH"
    [systemd_config]="изменён systemd-юнит"
    [identity]="изменён файл учётных записей (passwd/shadow)"
    [sudoers]="изменены права sudo"
    [root_keys]="изменены SSH-ключи root"
    [deploy_keys]="изменены SSH-ключи deploy"
  )

  for key in "${!KEY_MEANING[@]}"; do
    # Без sudo: procode-monitor читает /var/log/audit напрямую по ACL
    # (см. DEPLOYMENT.md) — с NoNewPrivileges=true в юните sudo всё равно
    # не смог бы поднять права, а лишний root тут и не нужен.
    local text
    text="$(ausearch -k "$key" -ts "$from" --format text 2>/dev/null)"
    [ -z "$text" ] && continue
    send_telegram "🟠 ${KEY_MEANING[$key]}.
Чем грозит: если это не ваше действие (не деплой и не ручная правка) — возможен взлом. Подробности:
${text}"
    log "AUDIT [$key]: $text"
  done

  echo "$now" >"$ts_file"
}

# ------------------------------------------------------------------- запуск

check_service procode.service "Сайт"
check_service nginx.service "nginx"
check_service fail2ban.service "fail2ban"
check_healthz
check_mem
check_disk
check_load
check_synrecv
check_ssh_logins
check_oom
check_audit

log "проверка завершена"
