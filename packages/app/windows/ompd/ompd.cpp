// ompd.cpp : Defines the entry point for the application.
//

#include "pch.h"
#include "ompd.h"

#include "AutolinkedNativeModules.g.h"

#include "NativeModules.h"
#include <fstream>

static void LogDiagnostic(const std::wstring &line) {
  WCHAR tempPath[MAX_PATH];
  if (GetTempPathW(MAX_PATH, tempPath)) {
    std::wstring logFile = std::wstring(tempPath) + L"ompd_diagnostics.log";
    std::wofstream out(logFile, std::ios::app);
    if (out.is_open()) {
      out << line << L"\n";
      out.flush();
    }
  }
  OutputDebugStringW((line + L"\n").c_str());
}

struct CustomRedBoxHandler : winrt::implements<CustomRedBoxHandler, winrt::Microsoft::ReactNative::IRedBoxHandler> {
  void ShowNewError(winrt::Microsoft::ReactNative::IRedBoxErrorInfo const &info, winrt::Microsoft::ReactNative::RedBoxErrorType) noexcept {
    LogDiagnostic(std::wstring(L"[RedBox Error] ") + info.Message().c_str());
  }
  bool IsDevSupportEnabled() const noexcept { return true; }
  void UpdateError(winrt::Microsoft::ReactNative::IRedBoxErrorInfo const &) noexcept {}
  void DismissRedBox() noexcept {}
};

// A PackageProvider containing any turbo modules you define within this app project
struct CompReactPackageProvider
    : winrt::implements<CompReactPackageProvider, winrt::Microsoft::ReactNative::IReactPackageProvider> {
 public: // IReactPackageProvider
  void CreatePackage(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept {
    AddAttributedModules(packageBuilder, true);
  }
};

// The entry point of the Win32 application
_Use_decl_annotations_ int CALLBACK WinMain(HINSTANCE instance, HINSTANCE, PSTR /* commandLine */, int showCmd) {
  // Initialize WinRT
  winrt::init_apartment(winrt::apartment_type::single_threaded);

  // Enable per monitor DPI scaling
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // Find the path hosting the app exe file
  WCHAR appDirectory[MAX_PATH];
  GetModuleFileNameW(NULL, appDirectory, MAX_PATH);
  PathCchRemoveFileSpec(appDirectory, MAX_PATH);

  // Create a ReactNativeWin32App with the ReactNativeAppBuilder
  auto reactNativeWin32App{winrt::Microsoft::ReactNative::ReactNativeAppBuilder().Build()};

  // Configure the initial InstanceSettings for the app's ReactNativeHost
  auto settings{reactNativeWin32App.ReactNativeHost().InstanceSettings()};
  // Register any autolinked native modules
  RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
  // Register any native modules defined within this app project
  settings.PackageProviders().Append(winrt::make<CompReactPackageProvider>());

  LogDiagnostic(L"ompd WinMain started");
  LogDiagnostic(std::wstring(L"appDirectory: ") + appDirectory);

  std::wstring directBundle = std::wstring(appDirectory) + L"\\Bundle\\index.windows.bundle";
  DWORD directAttr = GetFileAttributesW(directBundle.c_str());
  LogDiagnostic(std::wstring(L"direct bundle exists=") + (directAttr != INVALID_FILE_ATTRIBUTES ? L"yes: " : L"no: ") + directBundle);

  std::wstring parentBundle = std::wstring(appDirectory) + L"\\..\\Bundle\\index.windows.bundle";
  DWORD parentAttr = GetFileAttributesW(parentBundle.c_str());
  LogDiagnostic(std::wstring(L"parent bundle exists=") + (parentAttr != INVALID_FILE_ATTRIBUTES ? L"yes: " : L"no: ") + parentBundle);

  if (directAttr != INVALID_FILE_ATTRIBUTES) {
    settings.BundleRootPath(std::wstring(appDirectory).append(L"\\Bundle\\").c_str());
  } else if (parentAttr != INVALID_FILE_ATTRIBUTES) {
    WCHAR canonical[MAX_PATH];
    if (PathCchCanonicalize(canonical, MAX_PATH, (std::wstring(appDirectory) + L"\\..\\Bundle\\").c_str()) == S_OK) {
      settings.BundleRootPath(canonical);
    } else {
      settings.BundleRootPath(L"ms-appx:///Bundle/");
    }
  } else {
    settings.BundleRootPath(L"ms-appx:///Bundle/");
  }

  settings.NativeLogger([](winrt::Microsoft::ReactNative::LogLevel level, winrt::hstring const &message) {
    LogDiagnostic(std::wstring(L"[RN Log] ") + message.c_str());
  });

  settings.InstanceLoaded([](auto const &, winrt::Microsoft::ReactNative::InstanceLoadedEventArgs const &args) {
    LogDiagnostic(std::wstring(L"[RN InstanceLoaded] failed=") + (args.Failed() ? L"true" : L"false"));
  });

  settings.RedBoxHandler(winrt::make<CustomRedBoxHandler>());

  // Set the name of the bundle file (without the .bundle extension)
  settings.JavaScriptBundleFile(L"index.windows");

  // JS Entry file to use when loading from Metro:
  settings.DebugBundlePath(L"index");

#if BUNDLE
  // Disable hot reload - bundle will be loaded from prebuilt bundle file.
  settings.UseFastRefresh(false);
#else
  // Enable hot reload - load the JS bundle from Metro
  settings.UseFastRefresh(true);
#endif
#if _DEBUG
  // For Debug builds
  // Enable Direct Debugging of JS
  settings.UseDirectDebugger(true);
  // Enable the Developer Menu
  settings.UseDeveloperSupport(true);
#else
  // For Release builds:
  // Disable Direct Debugging of JS
  settings.UseDirectDebugger(false);
  // Disable the Developer Menu
  settings.UseDeveloperSupport(false);
#endif

  // Get the AppWindow so we can configure its initial title and size
  auto appWindow{reactNativeWin32App.AppWindow()};
  appWindow.Title(L"ompctl");
  appWindow.Resize({1000, 1000});

  // Get the ReactViewOptions so we can set the initial RN component to load
  auto viewOptions{reactNativeWin32App.ReactViewOptions()};
  viewOptions.ComponentName(L"ompctl");

  // Start the app
  reactNativeWin32App.Start();
}
