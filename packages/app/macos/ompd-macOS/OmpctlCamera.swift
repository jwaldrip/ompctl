import AVFoundation
import AppKit
import React

/**
 * Native macOS camera capture and QR decoding module.
 *
 * Provides AVCaptureSession and AVCaptureMetadataOutput scanning on macOS
 * where react-native-vision-camera lacks native platform support.
 */
@objc(OmpctlCamera)
final class OmpctlCamera: NSObject, RCTInvalidating, AVCaptureMetadataOutputObjectsDelegate {
  static let sessionDidChangeNotification = Notification.Name("ai.ompctl.camera.sessionDidChange")
  static weak var shared: OmpctlCamera?

  @objc var callableJSModules: RCTCallableJSModules!

  private let sessionQueue = DispatchQueue(label: "ai.ompctl.camera.session")
  private var session: AVCaptureSession?

  var currentSession: AVCaptureSession? {
    return session
  }

  override init() {
    super.init()
    OmpctlCamera.shared = self
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleDeviceChange(_:)),
      name: AVCaptureDevice.wasConnectedNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleDeviceChange(_:)),
      name: AVCaptureDevice.wasDisconnectedNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    tearDownSessionSync()
  }

  @objc private func handleDeviceChange(_: Notification) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, let modules = self.callableJSModules else { return }
      modules.invokeModule("RCTDeviceEventEmitter", method: "emit", withArgs: ["onCameraDevicesChanged", []])
    }
  }

  private func statusString(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized:
      return "authorized"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    case .notDetermined:
      return "notDetermined"
    @unknown default:
      return "unknown"
    }
  }

  @objc(hasCamera:rejecter:)
  func hasCamera(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    let device = AVCaptureDevice.default(for: .video)
    resolve(device != nil)
  }

  @objc(getAvailableDevices:rejecter:)
  func getAvailableDevices(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    var deviceTypes: [AVCaptureDevice.DeviceType] = [
      .builtInWideAngleCamera,
      .externalUnknown,
    ]
    if #available(macOS 14.0, *) {
      deviceTypes.append(.continuityCamera)
    }
    let discoverySession = AVCaptureDevice.DiscoverySession(
      deviceTypes: deviceTypes,
      mediaType: .video,
      position: .unspecified
    )
    let devices = discoverySession.devices.map { device in
      [
        "id": device.uniqueID,
        "name": device.localizedName,
      ]
    }
    resolve(devices)
  }

  @objc(checkPermission:rejecter:)
  func checkPermission(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    let status = AVCaptureDevice.authorizationStatus(for: .video)
    resolve(statusString(status))
  }

  @objc(requestPermission:rejecter:)
  func requestPermission(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    AVCaptureDevice.requestAccess(for: .video) { granted in
      resolve(granted)
    }
  }

  @objc(startSession:rejecter:)
  func startSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    startSessionWithDevice(nil, resolver: resolve, rejecter: reject)
  }

  @objc(startSessionWithDevice:resolver:rejecter:)
  func startSessionWithDevice(
    _ deviceId: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    sessionQueue.async { [weak self] in
      guard let self = self else {
        resolve(nil)
        return
      }

      let status = AVCaptureDevice.authorizationStatus(for: .video)
      guard status == .authorized else {
        reject("E_PERMISSION", "Camera access is not authorized: \(self.statusString(status))", nil)
        return
      }

      let device: AVCaptureDevice?
      if let requestedId = deviceId, !requestedId.isEmpty {
        device = AVCaptureDevice(uniqueID: requestedId) ?? AVCaptureDevice.default(for: .video)
      } else {
        device = AVCaptureDevice.default(for: .video)
      }

      guard let targetDevice = device else {
        reject("E_NO_CAMERA", "No camera device available on this Mac", nil)
        return
      }

      if let currentSession = self.session, currentSession.isRunning {
        if let currentInput = currentSession.inputs.first as? AVCaptureDeviceInput,
           currentInput.device.uniqueID == targetDevice.uniqueID {
          resolve(nil)
          return
        }
        self.tearDownSessionSync()
      }

      let captureSession = self.session ?? AVCaptureSession()
      self.session = captureSession

      captureSession.beginConfiguration()
      for input in captureSession.inputs {
        captureSession.removeInput(input)
      }
      for output in captureSession.outputs {
        captureSession.removeOutput(output)
      }

      do {
        let input = try AVCaptureDeviceInput(device: targetDevice)
        guard captureSession.canAddInput(input) else {
          captureSession.commitConfiguration()
          reject("E_INPUT_FAILED", "Could not add camera input to capture session", nil)
          return
        }
        captureSession.addInput(input)

        let metadataOutput = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(metadataOutput) else {
          captureSession.commitConfiguration()
          reject("E_OUTPUT_FAILED", "Could not add metadata output to capture session", nil)
          return
        }
        captureSession.addOutput(metadataOutput)

        metadataOutput.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        if metadataOutput.availableMetadataObjectTypes.contains(.qr) {
          metadataOutput.metadataObjectTypes = [.qr]
        } else {
          captureSession.commitConfiguration()
          reject("E_QR_UNSUPPORTED", "QR metadata decoding not supported by capture output", nil)
          return
        }

        captureSession.commitConfiguration()
        captureSession.startRunning()

        DispatchQueue.main.async {
          NotificationCenter.default.post(
            name: OmpctlCamera.sessionDidChangeNotification,
            object: captureSession
          )
        }
        resolve(nil)
      } catch {
        captureSession.commitConfiguration()
        reject("E_SETUP_FAILED", "Failed to start camera capture session: \(error.localizedDescription)", error)
      }
    }
  }

  @objc(stopSession:rejecter:)
  func stopSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    sessionQueue.async { [weak self] in
      guard let self = self else {
        resolve(nil)
        return
      }
      self.tearDownSessionSync()
      resolve(nil)
    }
  }

  private func tearDownSessionSync() {
    guard let captureSession = session else { return }
    if captureSession.isRunning {
      captureSession.stopRunning()
    }
    captureSession.beginConfiguration()
    for input in captureSession.inputs {
      captureSession.removeInput(input)
    }
    for output in captureSession.outputs {
      captureSession.removeOutput(output)
    }
    captureSession.commitConfiguration()
    session = nil

    DispatchQueue.main.async {
      NotificationCenter.default.post(
        name: OmpctlCamera.sessionDidChangeNotification,
        object: nil
      )
    }
  }

  func metadataOutput(
    _: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from _: AVCaptureConnection
  ) {
    for metadataObject in metadataObjects {
      guard let readable = metadataObject as? AVMetadataMachineReadableCodeObject,
            readable.type == .qr,
            let stringValue = readable.stringValue else {
        continue
      }
      emitCodeScanned(stringValue)
    }
  }

  private func emitCodeScanned(_ value: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, let modules = self.callableJSModules else { return }
      let code: [String: Any] = ["type": "qr", "value": value]
      modules.invokeModule("RCTDeviceEventEmitter", method: "emit", withArgs: ["onCodeScanned", [code]])
    }
  }

  @objc(addListener:callback:)
  func addListener(_: String, callback _: @escaping RCTResponseSenderBlock) {}

  @objc(removeListeners:)
  func removeListeners(_: Double) {}

  func invalidate() {
    sessionQueue.async { [weak self] in
      self?.tearDownSessionSync()
    }
  }

  @objc func constantsToExport() -> [AnyHashable: Any]! {
    let status = AVCaptureDevice.authorizationStatus(for: .video)
    let hasPerm = status == .authorized
    let hasCam = AVCaptureDevice.default(for: .video) != nil
    return [
      "hasPermission": hasPerm,
      "hasCamera": hasCam,
      "permissionStatus": statusString(status),
    ]
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    return true
  }
}

/**
 * Native AppKit viewfinder view hosting an AVCaptureVideoPreviewLayer.
 */
final class OmpctlCameraPreviewView: NSView {
  private let previewLayer = AVCaptureVideoPreviewLayer()

  override init(frame: NSRect) {
    super.init(frame: frame)
    setup()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setup()
  }

  private func setup() {
    wantsLayer = true
    previewLayer.videoGravity = .resizeAspectFill
    layer?.addSublayer(previewLayer)
    updateSession(OmpctlCamera.shared?.currentSession)

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleSessionChange(_:)),
      name: OmpctlCamera.sessionDidChangeNotification,
      object: nil
    )
  }

  @objc private func handleSessionChange(_ notification: Notification) {
    let session = notification.object as? AVCaptureSession
    updateSession(session)
  }

  private func updateSession(_ session: AVCaptureSession?) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.previewLayer.session = session
    }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window != nil {
      updateSession(OmpctlCamera.shared?.currentSession)
    } else {
      updateSession(nil)
    }
  }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer.frame = bounds
    CATransaction.commit()
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    previewLayer.session = nil
  }
}

/**
 * View manager exporting OmpctlCameraPreviewView to React Native.
 */
@objc(OmpctlCameraPreviewManager)
final class OmpctlCameraPreviewManager: RCTViewManager {
  override func view() -> NSView! {
    return OmpctlCameraPreviewView()
  }

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }
}
