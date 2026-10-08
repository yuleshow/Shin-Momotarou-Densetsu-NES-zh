#include <libretro.h>
#include <dlfcn.h>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

struct InputEvent {
    unsigned frame;
    unsigned duration;
    unsigned button;
};

static unsigned currentFrame = 0;
static unsigned lastFrame = 0;
static unsigned captureInterval = 300;
static retro_pixel_format pixelFormat = RETRO_PIXEL_FORMAT_0RGB1555;
static std::vector<InputEvent> inputs;
static std::filesystem::path output;
static std::string systemDirectory;

static std::vector<char> readBytes(const std::string &filename) {
    std::ifstream stream(filename, std::ios::binary);
    if (!stream) throw std::runtime_error("Cannot read " + filename);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

static void writeBytes(const std::filesystem::path &filename, const void *data, size_t size) {
    std::ofstream stream(filename, std::ios::binary);
    if (!stream || !stream.write(static_cast<const char *>(data), size)) {
        throw std::runtime_error("Cannot write " + filename.string());
    }
}

static void logMessage(retro_log_level, const char *format, ...) {
    va_list args;
    va_start(args, format);
    std::vfprintf(stderr, format, args);
    va_end(args);
}

static bool environment(unsigned command, void *data) {
    switch (command) {
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
            pixelFormat = *static_cast<retro_pixel_format *>(data);
            return pixelFormat <= RETRO_PIXEL_FORMAT_RGB565;
        case RETRO_ENVIRONMENT_GET_CAN_DUPE:
            *static_cast<bool *>(data) = true;
            return true;
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
            *static_cast<const char **>(data) = systemDirectory.c_str();
            return true;
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
            static_cast<retro_log_callback *>(data)->log = logMessage;
            return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE:
            static_cast<retro_variable *>(data)->value = nullptr;
            return false;
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
            *static_cast<bool *>(data) = false;
            return true;
        case RETRO_ENVIRONMENT_SET_VARIABLES:
        case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
        case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
            return true;
        default:
            return false;
    }
}

static void video(const void *data, unsigned width, unsigned height, size_t pitch) {
    if (!data || (currentFrame % captureInterval != 0 && currentFrame != lastFrame)) return;
    std::vector<unsigned char> rgb(width * height * 3);
    for (unsigned row = 0; row < height; row++) {
        const auto *source = static_cast<const unsigned char *>(data) + row * pitch;
        for (unsigned column = 0; column < width; column++) {
            unsigned red, green, blue;
            if (pixelFormat == RETRO_PIXEL_FORMAT_XRGB8888) {
                const auto pixel = reinterpret_cast<const uint32_t *>(source)[column];
                red = (pixel >> 16) & 255;
                green = (pixel >> 8) & 255;
                blue = pixel & 255;
            } else {
                const auto pixel = reinterpret_cast<const uint16_t *>(source)[column];
                const bool rgb565 = pixelFormat == RETRO_PIXEL_FORMAT_RGB565;
                red = ((pixel >> (rgb565 ? 11 : 10)) & 31) * 255 / 31;
                green = ((pixel >> 5) & (rgb565 ? 63 : 31)) * 255 / (rgb565 ? 63 : 31);
                blue = (pixel & 31) * 255 / 31;
            }
            const auto index = (row * width + column) * 3;
            rgb[index] = red;
            rgb[index + 1] = green;
            rgb[index + 2] = blue;
        }
    }
    const auto filename = output / ("frame-" + std::to_string(currentFrame) + ".ppm");
    std::ofstream stream(filename, std::ios::binary);
    stream << "P6\n" << width << " " << height << "\n255\n";
    stream.write(reinterpret_cast<const char *>(rgb.data()), rgb.size());
    if (!stream) throw std::runtime_error("Cannot write screenshot");
}

static int16_t inputState(unsigned port, unsigned device, unsigned, unsigned button) {
    if (port != 0 || device != RETRO_DEVICE_JOYPAD) return 0;
    for (const auto &event : inputs) {
        if (button == event.button && currentFrame >= event.frame && currentFrame - event.frame < event.duration) return 1;
    }
    return 0;
}

template <typename Function>
static Function symbol(void *library, const char *name) {
    auto address = dlsym(library, name);
    if (!address) throw std::runtime_error(std::string("Missing core export: ") + name);
    return reinterpret_cast<Function>(address);
}

int main(int argc, char **argv) {
    try {
        if (argc < 5 || argc > 7) throw std::runtime_error("Usage: run-rom CORE ROM NEW_OUTPUT_DIRECTORY FRAMES [FRAME:DURATION:BUTTON,...] [STATE]");
        output = argv[3];
        if (!std::filesystem::create_directory(output)) throw std::runtime_error("Output directory must not already exist");
        systemDirectory = std::filesystem::absolute(output).string();
        lastFrame = std::stoul(argv[4]);
        if (lastFrame == 0) throw std::runtime_error("Frame count must be positive");
        if (const char *interval = std::getenv("MOMOTARO_CAPTURE_EVERY")) {
            captureInterval = std::stoul(interval);
            if (captureInterval == 0) throw std::runtime_error("Capture interval must be positive");
        }
        const std::map<std::string, unsigned> buttons = {
            {"a", RETRO_DEVICE_ID_JOYPAD_A}, {"b", RETRO_DEVICE_ID_JOYPAD_B},
            {"x", RETRO_DEVICE_ID_JOYPAD_X}, {"y", RETRO_DEVICE_ID_JOYPAD_Y},
            {"start", RETRO_DEVICE_ID_JOYPAD_START}, {"select", RETRO_DEVICE_ID_JOYPAD_SELECT},
            {"up", RETRO_DEVICE_ID_JOYPAD_UP}, {"down", RETRO_DEVICE_ID_JOYPAD_DOWN},
            {"left", RETRO_DEVICE_ID_JOYPAD_LEFT}, {"right", RETRO_DEVICE_ID_JOYPAD_RIGHT},
            {"l", RETRO_DEVICE_ID_JOYPAD_L}, {"r", RETRO_DEVICE_ID_JOYPAD_R},
        };
        if (argc >= 6) {
            std::stringstream schedule(argv[5]);
            std::string entry;
            while (std::getline(schedule, entry, ',')) {
                std::stringstream fields(entry);
                std::string frame, duration, button;
                if (!std::getline(fields, frame, ':') || !std::getline(fields, duration, ':') || !std::getline(fields, button)) throw std::runtime_error("Invalid input event");
                inputs.push_back({static_cast<unsigned>(std::stoul(frame)), static_cast<unsigned>(std::stoul(duration)), buttons.at(button)});
            }
        }
        void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
        if (!library) throw std::runtime_error(dlerror());
        symbol<decltype(&retro_set_environment)>(library, "retro_set_environment")(environment);
        symbol<decltype(&retro_set_video_refresh)>(library, "retro_set_video_refresh")(video);
        symbol<decltype(&retro_set_audio_sample)>(library, "retro_set_audio_sample")([](int16_t, int16_t) {});
        symbol<decltype(&retro_set_audio_sample_batch)>(library, "retro_set_audio_sample_batch")([](const int16_t *, size_t frames) { return frames; });
        symbol<decltype(&retro_set_input_poll)>(library, "retro_set_input_poll")([]() {});
        symbol<decltype(&retro_set_input_state)>(library, "retro_set_input_state")(inputState);
        symbol<decltype(&retro_init)>(library, "retro_init")();
        const auto rom = readBytes(argv[2]);
        const retro_game_info game = {argv[2], rom.data(), rom.size(), nullptr};
        if (!symbol<decltype(&retro_load_game)>(library, "retro_load_game")(&game)) throw std::runtime_error("Core rejected ROM");
        symbol<decltype(&retro_set_controller_port_device)>(library, "retro_set_controller_port_device")(0, RETRO_DEVICE_JOYPAD);
        const auto memory = symbol<decltype(&retro_get_memory_data)>(library, "retro_get_memory_data");
        const auto memorySize = symbol<decltype(&retro_get_memory_size)>(library, "retro_get_memory_size");
        if (const char *saveFile = std::getenv("MOMOTARO_SRAM_FILE")) {
            if (argc == 7) throw std::runtime_error("SRAM input cannot be combined with an emulator state");
            const auto save = readBytes(saveFile);
            const auto size = memorySize(RETRO_MEMORY_SAVE_RAM);
            if (!size || !memory(RETRO_MEMORY_SAVE_RAM) || save.size() != size) throw std::runtime_error("SRAM size does not match ROM");
            std::memcpy(memory(RETRO_MEMORY_SAVE_RAM), save.data(), size);
        }
        if (argc == 7) {
            const auto state = readBytes(argv[6]);
            if (!symbol<decltype(&retro_unserialize)>(library, "retro_unserialize")(state.data(), state.size())) throw std::runtime_error("Core rejected state");
        }
        if (const char *codes = std::getenv("MOMOTARO_CHEATS")) {
            std::stringstream entries(codes);
            std::string code;
            unsigned index = 0;
            const auto cheatSet = symbol<decltype(&retro_cheat_set)>(library, "retro_cheat_set");
            while (std::getline(entries, code, ',')) {
                if (code.empty() || code.size() >= 256) throw std::runtime_error("Cheat code must contain 1 to 255 bytes");
                cheatSet(index++, true, code.c_str());
            }
        }
        const auto run = symbol<decltype(&retro_run)>(library, "retro_run");
        for (currentFrame = 1; currentFrame <= lastFrame; currentFrame++) {
            run();
            if (currentFrame % captureInterval == 0 || currentFrame == lastFrame) {
                for (const auto &[name, identifier] : std::map<std::string, unsigned>{{"wram", RETRO_MEMORY_SYSTEM_RAM}, {"vram", RETRO_MEMORY_VIDEO_RAM}}) {
                    const auto size = memorySize(identifier);
                    if (size && memory(identifier)) writeBytes(output / (name + "-" + std::to_string(currentFrame) + ".bin"), memory(identifier), size);
                }
            }
        }
        const auto stateSize = symbol<decltype(&retro_serialize_size)>(library, "retro_serialize_size")();
        std::vector<char> state(stateSize);
        if (!symbol<decltype(&retro_serialize)>(library, "retro_serialize")(state.data(), state.size())) throw std::runtime_error("State capture failed");
        writeBytes(output / "state.bin", state.data(), state.size());
        const auto saveSize = memorySize(RETRO_MEMORY_SAVE_RAM);
        if (saveSize && memory(RETRO_MEMORY_SAVE_RAM)) writeBytes(output / "sram.bin", memory(RETRO_MEMORY_SAVE_RAM), saveSize);
        symbol<decltype(&retro_unload_game)>(library, "retro_unload_game")();
        symbol<decltype(&retro_deinit)>(library, "retro_deinit")();
        dlclose(library);
        std::cout << "Captured " << lastFrame << " frames in " << output << "\n";
    } catch (const std::exception &error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
}