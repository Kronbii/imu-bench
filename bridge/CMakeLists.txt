cmake_minimum_required(VERSION 3.21)
project(imx_bridge CXX C)

# The Inertial Sense SDK: the sdk/ submodule (v2.7.1) unless -DIS_SDK_DIR=... says otherwise.
set(IS_SDK_DIR "${CMAKE_CURRENT_LIST_DIR}/../sdk" CACHE PATH "Inertial Sense SDK root")
get_filename_component(IS_SDK_DIR "${IS_SDK_DIR}" ABSOLUTE)
if(NOT EXISTS "${IS_SDK_DIR}/src/ISComm.h")
    message(FATAL_ERROR "Inertial Sense SDK not found at ${IS_SDK_DIR}; run: git submodule update --init --recursive")
endif()

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Uses the SDK's prebuilt static library when ${IS_SDK_DIR}/build has one,
# otherwise builds the SDK from source as part of this project.
include(${IS_SDK_DIR}/include_is_sdk_find_library.cmake)
include_directories(${IS_SDK_DIR}/src)

add_executable(${PROJECT_NAME} imx_bridge.cpp)
set_property(TARGET ${PROJECT_NAME} PROPERTY CXX_STANDARD 20)
set_property(TARGET ${PROJECT_NAME} PROPERTY POSITION_INDEPENDENT_CODE ON)

include(${IS_SDK_DIR}/include_is_sdk_target_link_libraries.cmake)
