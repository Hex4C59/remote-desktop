#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cstring>
#include <iomanip>
#include <iostream>

using Microsoft::WRL::ComPtr;

namespace {
int report_failure(const char* operation, HRESULT result) {
    std::cerr << operation << " failed: HRESULT=0x" << std::hex
              << static_cast<unsigned long>(result) << '\n';
    return 1;
}
}

int main(int argc, char** argv) {
    const bool capture = argc == 2 && std::strcmp(argv[1], "--capture") == 0;
    if (argc > 1 && !capture) {
        std::cerr << "Usage: windows_desktop_probe [--capture]\n";
        return 2;
    }
    DWORD session = 0;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &session)) {
        std::cerr << "ProcessIdToSessionId failed: " << GetLastError() << '\n';
        return 1;
    }
    std::cout << "process_session=" << session << "\n";
    if (capture && session == 0) {
        std::cerr << "Capture requires the logged-in desktop. Launch locally, not through SSH.\n";
        return 3;
    }
    if (session == 0) {
        std::cout << "desktop_check=skipped (noninteractive session; run --capture from desktop)\n";
        return 0;
    }

    ComPtr<IDXGIFactory1> factory;
    HRESULT result = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(result)) return report_failure("CreateDXGIFactory1", result);

    unsigned int outputs = 0;
    for (UINT adapter_index = 0;; ++adapter_index) {
        ComPtr<IDXGIAdapter1> adapter;
        result = factory->EnumAdapters1(adapter_index, &adapter);
        if (result == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(result)) return report_failure("EnumAdapters1", result);
        for (UINT output_index = 0;; ++output_index) {
            ComPtr<IDXGIOutput> output;
            result = adapter->EnumOutputs(output_index, &output);
            if (result == DXGI_ERROR_NOT_FOUND) break;
            if (FAILED(result)) return report_failure("EnumOutputs", result);
            DXGI_OUTPUT_DESC description{};
            result = output->GetDesc(&description);
            if (FAILED(result)) return report_failure("GetDesc", result);
            if (!description.AttachedToDesktop) continue;
            ++outputs;
            std::cout << "adapter=" << adapter_index << " output=" << output_index
                      << " width=" << description.DesktopCoordinates.right - description.DesktopCoordinates.left
                      << " height=" << description.DesktopCoordinates.bottom - description.DesktopCoordinates.top
                      << " rotation=" << description.Rotation << '\n';
            if (!capture) continue;

            ComPtr<ID3D11Device> device;
            result = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                      D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                      D3D11_SDK_VERSION, &device, nullptr, nullptr);
            if (FAILED(result)) return report_failure("D3D11CreateDevice", result);
            ComPtr<IDXGIOutput1> output1;
            result = output.As(&output1);
            if (FAILED(result)) return report_failure("QueryInterface IDXGIOutput1", result);
            ComPtr<IDXGIOutputDuplication> duplication;
            result = output1->DuplicateOutput(device.Get(), &duplication);
            if (FAILED(result)) return report_failure("DuplicateOutput", result);
            DXGI_OUTDUPL_FRAME_INFO frame_info{};
            ComPtr<IDXGIResource> frame;
            result = duplication->AcquireNextFrame(3000, &frame_info, &frame);
            if (FAILED(result)) return report_failure("AcquireNextFrame", result);
            // Only acquire/release the frame to verify access; do not save screen pixels.
            result = duplication->ReleaseFrame();
            if (FAILED(result)) return report_failure("ReleaseFrame", result);
            std::cout << "frame_acquired=true accumulated_frames=" << frame_info.AccumulatedFrames << '\n';
            return 0;
        }
    }
    std::cout << "attached_outputs=" << outputs << '\n';
    if (capture) {
        std::cerr << "No attached desktop output is available in this session.\n";
        return 4;
    }
    return 0;
}
