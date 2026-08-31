// Copyright (c) 2026 Wrench contributors
// Distributed under the Boost Software License, Version 1.0.
//
// This is a deliberately narrow TDLib user-client helper. It accepts exactly
// one versioned request on stdin, reads only fixed files below its cwd, and
// writes one bounded contact projection. It never accepts a Bot API token or
// a caller-selected TDLib function.

#include <td/telegram/Client.h>
#include <td/telegram/td_api.h>
#include <td/telegram/td_api.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <initializer_list>
#include <map>
#include <memory>
#include <optional>
#include <regex>
#include <signal.h>
#include <stdexcept>
#include <string>
#include <termios.h>
#include <unistd.h>
#include <utility>
#include <vector>

namespace td_api = td::td_api;

namespace {

constexpr char kImplementation[] = "wrench-telegram-tdlib";
constexpr char kTdlibVersion[] = "1.8.67";
constexpr char kSourceCommit[] =
    "d1085f9cebc5a62379991ae1652673954f229c1f";
constexpr std::size_t kMaximumContacts = 100000;
constexpr std::size_t kMaximumOutputBytes = 16U * 1024U * 1024U;
constexpr std::size_t kMaximumPromptBytes = 4096;

enum class Operation { kIdentity, kPair, kSync };
enum class RequestKind {
  kGetAuthorizationState,
  kSetParameters,
  kPhone,
  kEmailAddress,
  kEmailCode,
  kLoginCode,
  kPassword,
  kGetMe,
  kGetContacts,
  kClose
};

struct Invocation {
  Operation operation;
  std::optional<std::string> phone;
};

struct ClientConfig {
  std::int32_t api_id;
  std::string api_hash;
};

volatile sig_atomic_t g_hidden_terminal_active = 0;
volatile sig_atomic_t g_terminal_signal = 0;
int g_hidden_terminal_fd = -1;
termios g_hidden_terminal_initial{};

void record_terminal_signal(int signal_number) {
  g_terminal_signal = signal_number;
}

void install_terminal_signal_handlers() {
  struct sigaction action {};
  action.sa_handler = record_terminal_signal;
  (void)sigemptyset(&action.sa_mask);
  action.sa_flags = 0;
  for (const int signal_number : {SIGHUP, SIGINT, SIGQUIT, SIGTERM}) {
    if (::sigaction(signal_number, &action, nullptr) != 0) {
      throw std::runtime_error("terminal-signal-handler-unavailable");
    }
  }
}

class Tty final {
 public:
  Tty() : fd_(::open("/dev/tty", O_RDWR | O_CLOEXEC | O_NOFOLLOW)) {
    if (fd_ < 0) {
      throw std::runtime_error("controlling-terminal-unavailable");
    }
  }

  Tty(const Tty &) = delete;
  Tty &operator=(const Tty &) = delete;

  ~Tty() {
    restore_echo_noexcept();
    if (fd_ >= 0) {
      ::close(fd_);
    }
  }

  std::string prompt(const std::string &label, bool hidden) {
    write_all(label);
    termios initial{};
    bool changed = false;
    if (hidden) {
      if (::tcgetattr(fd_, &initial) != 0) {
        throw std::runtime_error("terminal-mode-unavailable");
      }
      termios private_mode = initial;
      private_mode.c_lflag &= static_cast<tcflag_t>(~ECHO);
      g_hidden_terminal_fd = fd_;
      g_hidden_terminal_initial = initial;
      g_hidden_terminal_active = 1;
      if (::tcsetattr(fd_, TCSAFLUSH, &private_mode) != 0) {
        g_hidden_terminal_active = 0;
        throw std::runtime_error("terminal-mode-unavailable");
      }
      changed = true;
    }

    std::string result;
    try {
      for (;;) {
        if (g_terminal_signal != 0) {
          throw std::runtime_error("terminal-interrupted");
        }
        char value = '\0';
        const ssize_t count = ::read(fd_, &value, 1);
        if (g_terminal_signal != 0) {
          throw std::runtime_error("terminal-interrupted");
        }
        if (count != 1) {
          throw std::runtime_error("terminal-read-failed");
        }
        if (value == '\n' || value == '\r') {
          break;
        }
        if (value == '\0' || result.size() >= kMaximumPromptBytes) {
          throw std::runtime_error("terminal-value-invalid");
        }
        result.push_back(value);
      }
    } catch (...) {
      if (changed) {
        restore_echo_noexcept();
      }
      throw;
    }
    if (changed) {
      if (::tcsetattr(fd_, TCSAFLUSH, &initial) != 0) {
        throw std::runtime_error("terminal-mode-unavailable");
      }
      g_hidden_terminal_active = 0;
      write_all("\n");
    }
    if (result.empty()) {
      throw std::runtime_error("terminal-value-empty");
    }
    return result;
  }

  void notice(const std::string &value) { write_all(value); }

 private:
  void restore_echo_noexcept() noexcept {
    if (g_hidden_terminal_active != 0 && g_hidden_terminal_fd == fd_) {
      (void)::tcsetattr(fd_, TCSAFLUSH, &g_hidden_terminal_initial);
      g_hidden_terminal_active = 0;
    }
  }

  void write_all(const std::string &value) {
    std::size_t offset = 0;
    while (offset < value.size()) {
      const ssize_t count = ::write(
          fd_, value.data() + offset, value.size() - offset);
      if (count <= 0) {
        throw std::runtime_error("terminal-write-failed");
      }
      offset += static_cast<std::size_t>(count);
    }
  }

  int fd_;
};

Invocation parse_invocation() {
  std::string line;
  if (!std::getline(std::cin, line) || line.size() > 256) {
    throw std::runtime_error("request-envelope-invalid");
  }
  std::string extra;
  if (std::getline(std::cin, extra)) {
    throw std::runtime_error("request-envelope-invalid");
  }
  if (line == R"({"schemaVersion":1,"operation":"identity"})") {
    return {Operation::kIdentity, std::nullopt};
  }
  if (line == R"({"schemaVersion":1,"operation":"sync"})") {
    return {Operation::kSync, std::nullopt};
  }
  if (line == R"({"schemaVersion":1,"operation":"pair","phone":null})") {
    return {Operation::kPair, std::nullopt};
  }
  static const std::regex pair_phone(
      R"wrench(^\{"schemaVersion":1,"operation":"pair","phone":"(\+?[0-9]{5,20})"\}$)wrench",
      std::regex::ECMAScript);
  std::smatch match;
  if (std::regex_match(line, match, pair_phone) && match.size() == 2) {
    return {Operation::kPair, match[1].str()};
  }
  throw std::runtime_error("request-envelope-invalid");
}

ClientConfig read_client_config() {
  std::ifstream input("client.conf", std::ios::binary);
  if (!input) {
    throw std::runtime_error("client-config-unavailable");
  }
  std::string content(
      (std::istreambuf_iterator<char>(input)),
      std::istreambuf_iterator<char>());
  if (content.size() > 256) {
    throw std::runtime_error("client-config-invalid");
  }
  static const std::regex pattern(
      R"(^api_id=([1-9][0-9]{0,9})\napi_hash=([a-f0-9]{32})\n$)",
      std::regex::ECMAScript);
  std::smatch match;
  if (!std::regex_match(content, match, pattern) || match.size() != 3) {
    throw std::runtime_error("client-config-invalid");
  }
  const long long parsed = std::stoll(match[1].str());
  if (parsed < 1 || parsed > 2147483647LL) {
    throw std::runtime_error("client-config-invalid");
  }
  return {static_cast<std::int32_t>(parsed), match[2].str()};
}

void append_bounded(std::string &target, const std::string &value) {
  if (value.size() > kMaximumOutputBytes - target.size()) {
    throw std::runtime_error("projection-too-large");
  }
  target.append(value);
}

void append_json_string(std::string &target, const std::string &value) {
  append_bounded(target, "\"");
  for (const char character : value) {
    const auto byte = static_cast<unsigned char>(character);
    switch (byte) {
      case '"':
        append_bounded(target, "\\\"");
        break;
      case '\\':
        append_bounded(target, "\\\\");
        break;
      case '\b':
        append_bounded(target, "\\b");
        break;
      case '\f':
        append_bounded(target, "\\f");
        break;
      case '\n':
        append_bounded(target, "\\n");
        break;
      case '\r':
        append_bounded(target, "\\r");
        break;
      case '\t':
        append_bounded(target, "\\t");
        break;
      default:
        if (byte < 0x20 || byte == 0x7f) {
          static constexpr char digits[] = "0123456789abcdef";
          std::string escaped = "\\u00";
          escaped.push_back(digits[(byte >> 4U) & 0x0fU]);
          escaped.push_back(digits[byte & 0x0fU]);
          append_bounded(target, escaped);
        } else {
          append_bounded(target, std::string(1, static_cast<char>(byte)));
        }
    }
  }
  append_bounded(target, "\"");
}

std::string primary_username(const td_api::user &user) {
  if (user.usernames_ == nullptr ||
      user.usernames_->active_usernames_.empty()) {
    return {};
  }
  return user.usernames_->active_usernames_.front();
}

std::string display_name(const td_api::user &user) {
  if (user.first_name_.empty()) {
    if (!user.last_name_.empty()) {
      return user.last_name_;
    }
    const std::string username = primary_username(user);
    if (!username.empty()) {
      return username;
    }
    return "Telegram user " + std::to_string(user.id_);
  }
  return user.last_name_.empty()
             ? user.first_name_
             : user.first_name_ + " " + user.last_name_;
}

class TdlibSession final {
 public:
  TdlibSession(Operation operation, std::optional<std::string> phone,
               ClientConfig config)
      : operation_(operation), phone_(std::move(phone)), config_(std::move(config)) {
    (void)td::ClientManager::execute(
        td_api::make_object<td_api::setLogVerbosityLevel>(0));
    (void)td::ClientManager::execute(td_api::make_object<td_api::setLogStream>(
        td_api::make_object<td_api::logStreamEmpty>()));
    manager_ = std::make_unique<td::ClientManager>();
    client_id_ = manager_->create_client_id();
  }

  TdlibSession(const TdlibSession &) = delete;
  TdlibSession &operator=(const TdlibSession &) = delete;

  ~TdlibSession() { close_noexcept(); }

  std::string capture() {
    send(td_api::make_object<td_api::getAuthorizationState>(),
         RequestKind::kGetAuthorizationState);
    const auto deadline = std::chrono::steady_clock::now() +
                          (operation_ == Operation::kPair
                               ? std::chrono::minutes(9)
                               : std::chrono::seconds(90));
    while (!projection_ready_) {
      if (g_terminal_signal != 0) {
        throw std::runtime_error("tdlib-operation-interrupted");
      }
      if (std::chrono::steady_clock::now() >= deadline) {
        throw std::runtime_error("tdlib-operation-timeout");
      }
      auto response = manager_->receive(1.0);
      if (response.object == nullptr) {
        continue;
      }
      process(response.request_id, std::move(response.object));
    }
    std::string result = build_projection();
    close_checked();
    return result;
  }

 private:
  template <class Function>
  void send(td_api::object_ptr<Function> function, RequestKind kind) {
    const std::uint64_t id = ++next_request_id_;
    requests_.emplace(id, kind);
    if (is_retryable_authentication(kind) ||
        kind == RequestKind::kSetParameters) {
      active_authentication_request_id_ = id;
    }
    manager_->send(client_id_, id, std::move(function));
  }

  void process(std::uint64_t request_id, td_api::object_ptr<td_api::Object> object) {
    if (object->get_id() == td_api::updateAuthorizationState::ID) {
      auto update = td::move_tl_object_as<td_api::updateAuthorizationState>(
          object);
      if (update->authorization_state_ == nullptr) {
        throw std::runtime_error("telegram-authorization-state-missing");
      }
      accept_authorization_state(*update->authorization_state_);
      return;
    }
    if (object->get_id() == td_api::updateUser::ID) {
      auto update = td::move_tl_object_as<td_api::updateUser>(object);
      if (update->user_ == nullptr || update->user_->id_ <= 0) {
        throw std::runtime_error("tdlib-user-update-invalid");
      }
      users_[update->user_->id_] = std::move(update->user_);
      return;
    }
    if (request_id == 0) {
      return;
    }
    const auto found = requests_.find(request_id);
    if (found == requests_.end()) {
      throw std::runtime_error("tdlib-request-correlation-invalid");
    }
    const RequestKind kind = found->second;
    requests_.erase(found);
    if (kind == RequestKind::kGetAuthorizationState) {
      if (object->get_id() == td_api::error::ID) {
        throw std::runtime_error("tdlib-authorization-state-unavailable");
      }
      accept_authorization_state(*object);
      return;
    }
    const bool active_authentication_response =
        active_authentication_request_id_.has_value() &&
        *active_authentication_request_id_ == request_id;
    if ((is_retryable_authentication(kind) ||
         kind == RequestKind::kSetParameters) &&
        !active_authentication_response) {
      return;
    }
    if (active_authentication_response) {
      active_authentication_request_id_.reset();
    }
    if (object->get_id() == td_api::error::ID) {
      if (is_retryable_authentication(kind) &&
          operation_ == Operation::kPair &&
          ++authentication_failures_ <= 10 &&
          authorization_state_id_ != 0) {
        tty().notice("Telegram rejected the supplied authentication value. Try again.\n");
        on_authorization_state();
        return;
      }
      throw std::runtime_error("tdlib-request-rejected");
    }
    switch (kind) {
      case RequestKind::kGetAuthorizationState:
        throw std::runtime_error("tdlib-request-correlation-invalid");
      case RequestKind::kSetParameters:
      case RequestKind::kPhone:
      case RequestKind::kEmailAddress:
      case RequestKind::kEmailCode:
      case RequestKind::kLoginCode:
      case RequestKind::kPassword:
      case RequestKind::kClose:
        if (object->get_id() != td_api::ok::ID) {
          throw std::runtime_error("tdlib-request-response-invalid");
        }
        return;
      case RequestKind::kGetMe: {
        if (object->get_id() != td_api::user::ID) {
          throw std::runtime_error("tdlib-get-me-response-invalid");
        }
        auto user = td::move_tl_object_as<td_api::user>(object);
        if (user->id_ <= 0) {
          throw std::runtime_error("tdlib-self-identity-invalid");
        }
        self_id_ = user->id_;
        users_[user->id_] = std::move(user);
        send(td_api::make_object<td_api::getContacts>(),
             RequestKind::kGetContacts);
        return;
      }
      case RequestKind::kGetContacts: {
        if (object->get_id() != td_api::users::ID) {
          throw std::runtime_error("tdlib-get-contacts-response-invalid");
        }
        auto contacts = td::move_tl_object_as<td_api::users>(object);
        if (contacts->total_count_ < 0 ||
            static_cast<std::size_t>(contacts->total_count_) !=
                contacts->user_ids_.size() ||
            contacts->user_ids_.size() > kMaximumContacts) {
          throw std::runtime_error("tdlib-contact-count-invalid");
        }
        contact_ids_ = std::move(contacts->user_ids_);
        std::sort(contact_ids_.begin(), contact_ids_.end());
        if (std::adjacent_find(contact_ids_.begin(), contact_ids_.end()) !=
            contact_ids_.end()) {
          throw std::runtime_error("tdlib-contact-identity-duplicate");
        }
        for (const std::int64_t id : contact_ids_) {
          if (id <= 0 || users_.find(id) == users_.end()) {
            throw std::runtime_error("tdlib-contact-projection-incomplete");
          }
        }
        projection_ready_ = true;
        return;
      }
    }
  }

  static bool is_retryable_authentication(RequestKind kind) {
    switch (kind) {
      case RequestKind::kPhone:
      case RequestKind::kEmailAddress:
      case RequestKind::kEmailCode:
      case RequestKind::kLoginCode:
      case RequestKind::kPassword:
        return true;
      default:
        return false;
    }
  }

  void accept_authorization_state(const td_api::Object &state) {
    const std::int32_t state_id = state.get_id();
    switch (state_id) {
      case td_api::authorizationStateWaitTdlibParameters::ID:
      case td_api::authorizationStateWaitPhoneNumber::ID:
      case td_api::authorizationStateWaitPremiumPurchase::ID:
      case td_api::authorizationStateWaitEmailAddress::ID:
      case td_api::authorizationStateWaitEmailCode::ID:
      case td_api::authorizationStateWaitCode::ID:
      case td_api::authorizationStateWaitRegistration::ID:
      case td_api::authorizationStateWaitPassword::ID:
      case td_api::authorizationStateReady::ID:
      case td_api::authorizationStateLoggingOut::ID:
      case td_api::authorizationStateClosing::ID:
      case td_api::authorizationStateClosed::ID:
        other_device_link_.clear();
        break;
      case td_api::authorizationStateWaitOtherDeviceConfirmation::ID: {
        const auto &confirmation = static_cast<const
            td_api::authorizationStateWaitOtherDeviceConfirmation &>(state);
        other_device_link_ = confirmation.link_;
        break;
      }
      default:
        throw std::runtime_error("telegram-authorization-state-unsupported");
    }
    if (authorization_state_id_ == state_id &&
        active_authentication_request_id_.has_value()) {
      return;
    }
    authorization_state_id_ = state_id;
    on_authorization_state();
  }

  void on_authorization_state() {
    if (authorization_state_id_ == 0) {
      throw std::runtime_error("telegram-authorization-state-missing");
    }
    switch (authorization_state_id_) {
      case td_api::authorizationStateWaitTdlibParameters::ID: {
        auto parameters = td_api::make_object<td_api::setTdlibParameters>();
        parameters->use_test_dc_ = false;
        parameters->database_directory_ = "tdlib";
        parameters->files_directory_ = "tdlib-files";
        parameters->database_encryption_key_ = "";
        parameters->use_file_database_ = true;
        parameters->use_chat_info_database_ = false;
        parameters->use_message_database_ = false;
        parameters->use_secret_chats_ = false;
        parameters->api_id_ = config_.api_id;
        parameters->api_hash_ = config_.api_hash;
        parameters->system_language_code_ = "en";
        parameters->device_model_ = "Wrench TDLib contact bridge";
        parameters->system_version_ = "";
        parameters->application_version_ = "1";
        send(std::move(parameters), RequestKind::kSetParameters);
        std::fill(config_.api_hash.begin(), config_.api_hash.end(), '\0');
        return;
      }
      case td_api::authorizationStateWaitPhoneNumber::ID: {
        require_pairing_state();
        std::string phone = phone_.has_value()
                                ? std::exchange(*phone_, std::string())
                                : tty().prompt(
                                      "Telegram phone number (international format): ",
                                      true);
        phone_.reset();
        send(td_api::make_object<td_api::setAuthenticationPhoneNumber>(
                 phone, nullptr),
             RequestKind::kPhone);
        std::fill(phone.begin(), phone.end(), '\0');
        return;
      }
      case td_api::authorizationStateWaitEmailAddress::ID: {
        require_pairing_state();
        std::string value = tty().prompt("Telegram login email address: ", true);
        send(td_api::make_object<td_api::setAuthenticationEmailAddress>(value),
             RequestKind::kEmailAddress);
        std::fill(value.begin(), value.end(), '\0');
        return;
      }
      case td_api::authorizationStateWaitEmailCode::ID: {
        require_pairing_state();
        std::string value = tty().prompt("Telegram email authentication code: ", true);
        send(td_api::make_object<td_api::checkAuthenticationEmailCode>(
                 td_api::make_object<td_api::emailAddressAuthenticationCode>(
                     value)),
             RequestKind::kEmailCode);
        std::fill(value.begin(), value.end(), '\0');
        return;
      }
      case td_api::authorizationStateWaitCode::ID: {
        require_pairing_state();
        std::string value = tty().prompt("Telegram login code: ", true);
        send(td_api::make_object<td_api::checkAuthenticationCode>(value),
             RequestKind::kLoginCode);
        std::fill(value.begin(), value.end(), '\0');
        return;
      }
      case td_api::authorizationStateWaitPassword::ID: {
        require_pairing_state();
        std::string value = tty().prompt("Telegram two-step verification password: ", true);
        send(td_api::make_object<td_api::checkAuthenticationPassword>(value),
             RequestKind::kPassword);
        std::fill(value.begin(), value.end(), '\0');
        return;
      }
      case td_api::authorizationStateWaitOtherDeviceConfirmation::ID: {
        require_pairing_state();
        static const std::regex confirmation_link(
            R"(^tg://login\?token=[A-Za-z0-9_-]{1,2048}$)",
            std::regex::ECMAScript);
        if (!std::regex_match(other_device_link_, confirmation_link)) {
          throw std::runtime_error("tdlib-other-device-link-invalid");
        }
        tty().notice(
            "Confirm this Telegram login on another signed-in device:\n" +
            other_device_link_ + "\n");
        return;
      }
      case td_api::authorizationStateWaitRegistration::ID:
        throw std::runtime_error("telegram-registration-refused");
      case td_api::authorizationStateWaitPremiumPurchase::ID:
        throw std::runtime_error("telegram-premium-purchase-refused");
      case td_api::authorizationStateReady::ID:
        if (!capture_started_) {
          capture_started_ = true;
          send(td_api::make_object<td_api::getMe>(), RequestKind::kGetMe);
        }
        return;
      case td_api::authorizationStateLoggingOut::ID:
        throw std::runtime_error("telegram-session-logging-out");
      case td_api::authorizationStateClosing::ID:
        return;
      case td_api::authorizationStateClosed::ID:
        closed_ = true;
        if (!closing_) {
          throw std::runtime_error("telegram-session-closed");
        }
        return;
      default:
        throw std::runtime_error("telegram-authorization-state-unsupported");
    }
  }

  void require_pairing_state() const {
    if (operation_ != Operation::kPair) {
      throw std::runtime_error("telegram-session-not-paired");
    }
  }

  Tty &tty() {
    if (tty_ == nullptr) {
      tty_ = std::make_unique<Tty>();
    }
    return *tty_;
  }

  std::string build_projection() const {
    if (self_id_ <= 0) {
      throw std::runtime_error("tdlib-self-identity-missing");
    }
    std::string output;
    output.reserve(std::min<std::size_t>(
        kMaximumOutputBytes, 512 + contact_ids_.size() * 256));
    append_bounded(output, R"({"schemaVersion":1,"operation":")");
    append_bounded(output, operation_ == Operation::kPair ? "pair" : "sync");
    append_bounded(output, R"(","status":"ok","sourceCommit":")");
    append_bounded(output, kSourceCommit);
    append_bounded(output, R"(","accountSubject":"telegram:user:)");
    append_bounded(output, std::to_string(self_id_));
    append_bounded(output, R"(","contacts":[)");
    bool first = true;
    for (const std::int64_t id : contact_ids_) {
      const auto found = users_.find(id);
      if (found == users_.end() || found->second == nullptr) {
        throw std::runtime_error("tdlib-contact-projection-incomplete");
      }
      const td_api::user &user = *found->second;
      if (!first) append_bounded(output, ",");
      first = false;
      append_bounded(output, "{\"userId\":\"");
      append_bounded(output, std::to_string(user.id_));
      append_bounded(output, "\",\"firstName\":");
      append_json_string(output, user.first_name_);
      append_bounded(output, ",\"lastName\":");
      append_json_string(output, user.last_name_);
      append_bounded(output, ",\"displayName\":");
      append_json_string(output, display_name(user));
      const std::string username = primary_username(user);
      append_bounded(output, ",\"username\":");
      if (username.empty()) {
        append_bounded(output, "null");
      } else {
        append_json_string(output, username);
      }
      append_bounded(output, ",\"phoneNumber\":");
      if (user.phone_number_.empty()) {
        append_bounded(output, "null");
      } else {
        append_json_string(output, user.phone_number_);
      }
      append_bounded(output, ",\"isMutualContact\":");
      append_bounded(output, user.is_mutual_contact_ ? "true" : "false");
      append_bounded(output, ",\"isPremium\":");
      append_bounded(output, user.is_premium_ ? "true" : "false");
      append_bounded(output, ",\"isVerified\":");
      const bool verified = user.verification_status_ != nullptr &&
                            user.verification_status_->is_verified_;
      append_bounded(output, verified ? "true" : "false");
      append_bounded(output, "}");
    }
    append_bounded(output, "]}");
    return output;
  }

  void close_checked() {
    if (closed_) {
      manager_.reset();
      return;
    }
    closing_ = true;
    try {
      send(td_api::make_object<td_api::close>(), RequestKind::kClose);
      const auto deadline = std::chrono::steady_clock::now() +
                            std::chrono::seconds(5);
      while (!closed_ && std::chrono::steady_clock::now() < deadline) {
        auto response = manager_->receive(0.25);
        if (response.object != nullptr) {
          process(response.request_id, std::move(response.object));
        }
      }
      if (!closed_) {
        throw std::runtime_error("tdlib-close-unconfirmed");
      }
    } catch (...) {
      manager_.reset();
      throw;
    }
    manager_.reset();
  }

  void close_noexcept() noexcept {
    if (manager_ == nullptr || closed_) return;
    try {
      close_checked();
    } catch (...) {
      manager_.reset();
    }
  }

  Operation operation_;
  std::optional<std::string> phone_;
  ClientConfig config_;
  std::unique_ptr<Tty> tty_;
  std::unique_ptr<td::ClientManager> manager_;
  std::int32_t client_id_ = 0;
  std::int32_t authorization_state_id_ = 0;
  std::uint64_t next_request_id_ = 0;
  std::optional<std::uint64_t> active_authentication_request_id_;
  std::string other_device_link_;
  std::map<std::uint64_t, RequestKind> requests_;
  std::map<std::int64_t, td_api::object_ptr<td_api::user>> users_;
  std::vector<std::int64_t> contact_ids_;
  std::int64_t self_id_ = 0;
  std::size_t authentication_failures_ = 0;
  bool capture_started_ = false;
  bool projection_ready_ = false;
  bool closing_ = false;
  bool closed_ = false;
};

std::string identity_envelope() {
  return std::string(R"({"schemaVersion":1,"operation":"identity","status":"ok","implementation":")") +
         kImplementation + R"(","tdlibVersion":")" + kTdlibVersion +
         R"(","sourceCommit":")" + kSourceCommit + "\"}";
}

}  // namespace

int main() {
  try {
    Invocation invocation = parse_invocation();
    if (invocation.operation == Operation::kIdentity) {
      std::cout << identity_envelope() << '\n';
      return 0;
    }
    install_terminal_signal_handlers();
    ClientConfig config = read_client_config();
    TdlibSession session(invocation.operation, std::move(invocation.phone),
                         std::move(config));
    const std::string result = session.capture();
    std::cout << result << '\n';
    return 0;
  } catch (...) {
    // Runtime diagnostics are intentionally categorical. Authentication
    // values, TDLib errors, local paths, and private contact data never cross
    // stderr or a failed stdout envelope.
    return 1;
  }
}
