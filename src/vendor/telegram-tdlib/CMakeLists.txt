cmake_minimum_required(VERSION 3.18)

project(wrench_telegram_tdlib LANGUAGES CXX)

find_package(Td 1.8.67 EXACT REQUIRED)

add_executable(wrench-telegram-tdlib wrench_telegram_tdlib.cpp)
target_compile_features(wrench-telegram-tdlib PRIVATE cxx_std_17)
target_link_libraries(wrench-telegram-tdlib PRIVATE Td::TdStatic)

if(CMAKE_CXX_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
  target_compile_options(
    wrench-telegram-tdlib
    PRIVATE -Wall -Wextra -Wconversion -Werror
  )
endif()

install(TARGETS wrench-telegram-tdlib RUNTIME DESTINATION bin)
