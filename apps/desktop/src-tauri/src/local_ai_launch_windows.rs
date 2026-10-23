//! Windows-only, session-owned Ollama CLI. No shell, PATH discovery or process takeover.
//!
//! Installation metadata is only a locator. The locked executable must independently
//! pass Windows Authenticode trust and the official publisher identity check.

use super::{InstallationSource, InstalledRuntime, LaunchErrorCode, OwnedRuntime};
use std::{
    collections::BTreeMap,
    ffi::CStr,
    marker::PhantomData,
    mem::size_of,
    net::TcpListener,
    ptr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{
    Foundation::*,
    Globalization::{CompareStringOrdinal, CSTR_EQUAL},
    NetworkManagement::IpHelper::*,
    Networking::WinSock::AF_INET,
    Security::{Cryptography::*, WinTrust::*, SECURITY_ATTRIBUTES},
    Storage::FileSystem::*,
    System::{
        Com::CoTaskMemFree, Diagnostics::ToolHelp::*, JobObjects::*, Registry::*,
        SystemInformation::*, Threading::*,
    },
    UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_DONT_VERIFY},
};

const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{44E83376-CE68-45EB-8FC1-393500EB558C}_is1";
const MAX_PATH_UNITS: usize = 32_767;
const MAX_TABLE_BYTES: usize = 4 * 1024 * 1024;
const PORT: u16 = 11_434;
const LOOPBACK: u32 = u32::from_ne_bytes([127, 0, 0, 1]);

// Raw kernel handles are thread-safe; this owner never transfers or exposes them.
struct Handle(HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
impl Handle {
    fn new(raw: HANDLE, fallback: LaunchErrorCode) -> Result<Self, LaunchErrorCode> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(last_error(fallback))
        } else {
            Ok(Self(raw))
        }
    }
}

fn last_error(fallback: LaunchErrorCode) -> LaunchErrorCode {
    match unsafe { GetLastError() } {
        ERROR_ACCESS_DENIED | ERROR_PRIVILEGE_NOT_HELD => LaunchErrorCode::PermissionDenied,
        _ => fallback,
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn same_path(a: &str, b: &str) -> bool {
    let (a, b) = (wide(a), wide(b));
    unsafe {
        CompareStringOrdinal(
            a.as_ptr(),
            (a.len() - 1) as i32,
            b.as_ptr(),
            (b.len() - 1) as i32,
            1,
        ) == CSTR_EQUAL
    }
}

// Do not accept NT/device/UNC namespaces, relative paths, ADS, aliases or reparse
// traversal. A normal drive-rooted path is subsequently checked against its handle.
fn normal_local_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() > 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..3] == *b":\\"
        && path.encode_utf16().count() < MAX_PATH_UNITS
        && path[3..].split('\\').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !part.chars().any(|c| c < ' ' || "<>:\"/|?*".contains(c))
        })
}

fn known_default() -> Result<String, LaunchErrorCode> {
    let mut path = ptr::null_mut();
    let result = unsafe {
        SHGetKnownFolderPath(
            &FOLDERID_LocalAppData,
            KF_FLAG_DONT_VERIFY as u32,
            ptr::null_mut(),
            &mut path,
        )
    };
    if result < 0 || path.is_null() {
        return Err(LaunchErrorCode::PermissionDenied);
    }
    // The Known Folder API owns a NUL-terminated string, released on every outcome.
    let value = unsafe {
        let len = (0..MAX_PATH_UNITS).position(|n| *path.add(n) == 0);
        let value = len.and_then(|n| String::from_utf16(std::slice::from_raw_parts(path, n)).ok());
        CoTaskMemFree(path.cast());
        value
    }
    .ok_or(LaunchErrorCode::InstallationUntrusted)?;
    Ok(format!(
        "{}\\Programs\\Ollama\\ollama.exe",
        value.trim_end_matches('\\')
    ))
}

fn registered_location(root: HKEY, view: u32) -> Result<Option<String>, LaunchErrorCode> {
    let (key, name) = (wide(UNINSTALL_KEY), wide("InstallLocation"));
    let mut buffer = vec![0u16; MAX_PATH_UNITS];
    let mut bytes = (buffer.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ | RRF_NOEXPAND | view,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    match status {
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => return Ok(None),
        ERROR_ACCESS_DENIED => return Err(LaunchErrorCode::PermissionDenied),
        ERROR_SUCCESS => (),
        _ => return Err(LaunchErrorCode::InstallationUntrusted),
    }
    let units = bytes as usize / 2;
    if !bytes.is_multiple_of(2)
        || units == 0
        || units > buffer.len()
        || buffer[units - 1] != 0
        || buffer[..units - 1].contains(&0)
    {
        return Err(LaunchErrorCode::InstallationUntrusted);
    }
    let directory = String::from_utf16(&buffer[..units - 1])
        .map_err(|_| LaunchErrorCode::InstallationUntrusted)?;
    if directory.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "{}\\ollama.exe",
        directory.trim_end_matches('\\')
    )))
}

pub(crate) fn find_installation() -> Result<Option<Box<dyn InstalledRuntime>>, LaunchErrorCode> {
    let mut candidates = Vec::new();
    let mut failure = None;
    match known_default() {
        Ok(path) => candidates.push((path, InstallationSource::DefaultLocation)),
        Err(error) => failure = Some(error),
    }
    // The same three locations used by the official install.ps1; explicit registry
    // views avoid process-bitness-dependent redirection. Never read UninstallString.
    for (root, view) in [
        (HKEY_CURRENT_USER, RRF_SUBKEY_WOW6464KEY),
        (HKEY_LOCAL_MACHINE, RRF_SUBKEY_WOW6464KEY),
        (HKEY_LOCAL_MACHINE, RRF_SUBKEY_WOW6432KEY),
    ] {
        match registered_location(root, view) {
            Ok(Some(path)) if !candidates.iter().any(|(known, _)| same_path(known, &path)) => {
                candidates.push((path, InstallationSource::RegisteredLocation))
            }
            Ok(_) => (),
            Err(error) => failure = Some(error),
        }
    }
    for (path, source) in candidates {
        match LockedInstallation::open(path) {
            Ok(Some(frozen)) => {
                return Ok(Some(Box::new(WindowsInstallation {
                    source,
                    frozen: Arc::new(frozen),
                })))
            }
            Ok(None) => (),
            Err(error) => failure = Some(error),
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    index: [u8; 16],
    size: u64,
    written: u64,
}
fn file_information(handle: &Handle) -> Result<BY_HANDLE_FILE_INFORMATION, LaunchErrorCode> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(last_error(LaunchErrorCode::InstallationUntrusted));
    }
    if unsafe { GetFileType(handle.0) } != FILE_TYPE_DISK
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(LaunchErrorCode::InstallationUntrusted);
    }
    Ok(info)
}
fn identity(handle: &Handle) -> Result<FileIdentity, LaunchErrorCode> {
    let info = file_information(handle)?;
    let mut id = FILE_ID_INFO {
        VolumeSerialNumber: 0,
        FileId: FILE_ID_128::default(),
    };
    if unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileIdInfo,
            (&mut id as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error(LaunchErrorCode::InstallationUntrusted));
    }
    Ok(FileIdentity {
        volume: id.VolumeSerialNumber,
        index: id.FileId.Identifier,
        size: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
        written: (u64::from(info.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(info.ftLastWriteTime.dwLowDateTime),
    })
}
fn final_path(handle: &Handle) -> Result<String, LaunchErrorCode> {
    let mut buffer = vec![0u16; MAX_PATH_UNITS];
    let len = unsafe {
        GetFinalPathNameByHandleW(
            handle.0,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    } as usize;
    if len == 0 || len >= buffer.len() {
        return Err(last_error(LaunchErrorCode::InstallationUntrusted));
    }
    let path =
        String::from_utf16(&buffer[..len]).map_err(|_| LaunchErrorCode::InstallationUntrusted)?;
    let path = path
        .strip_prefix(r"\\?\")
        .ok_or(LaunchErrorCode::InstallationUntrusted)?;
    if !normal_local_path(path) {
        return Err(LaunchErrorCode::InstallationUntrusted);
    }
    Ok(path.to_owned())
}
fn open_file(path: &str) -> Result<Option<Handle>, LaunchErrorCode> {
    let raw = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE
        && matches!(
            unsafe { GetLastError() },
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND
        )
    {
        return Ok(None);
    }
    Handle::new(raw, LaunchErrorCode::InstallationUntrusted).map(Some)
}

struct LockedInstallation {
    path: String,
    directory: String,
    file: Handle,
    identity: FileIdentity,
}

fn inspect_directories(path: &str) -> Result<(), LaunchErrorCode> {
    for (end, _) in path.char_indices().filter(|(i, c)| *i > 2 && *c == '\\') {
        let directory = &path[..end];
        let handle = Handle::new(
            unsafe {
                CreateFileW(
                    wide(directory).as_ptr(),
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    ptr::null_mut(),
                )
            },
            LaunchErrorCode::InstallationUntrusted,
        )?;
        if file_information(&handle)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || !same_path(&final_path(&handle)?, directory)
        {
            return Err(LaunchErrorCode::InstallationUntrusted);
        }
    }
    Ok(())
}
impl LockedInstallation {
    fn open(path: String) -> Result<Option<Self>, LaunchErrorCode> {
        if !normal_local_path(&path) {
            return Err(LaunchErrorCode::InstallationUntrusted);
        }
        if unsafe { GetDriveTypeW(wide(&path[..3]).as_ptr()) } != 3
        /* DRIVE_FIXED */
        {
            return Err(LaunchErrorCode::InstallationUntrusted);
        }
        let Some(file) = open_file(&path)? else {
            return Ok(None);
        };
        // Inspection does not prevent ordinary ancestor-directory maintenance.
        inspect_directories(&path)?;
        let info = file_information(&file)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
            || !same_path(&final_path(&file)?, &path)
        {
            return Err(LaunchErrorCode::InstallationUntrusted);
        }
        let identity = identity(&file)?;
        verify_pe(&file, identity.size)?;
        verify_publisher(&file, &path)?;
        let directory = path
            .rsplit_once('\\')
            .ok_or(LaunchErrorCode::InstallationUntrusted)?
            .0
            .to_owned();
        Ok(Some(Self {
            path,
            directory,
            file,
            identity,
        }))
    }
    fn current_file(&self) -> Result<Handle, LaunchErrorCode> {
        let result = (|| {
            let current = open_file(&self.path)?.ok_or(LaunchErrorCode::InstallationChanged)?;
            if identity(&self.file)? != self.identity
                || identity(&current)? != self.identity
                || !same_path(&final_path(&current)?, &self.path)
            {
                return Err(LaunchErrorCode::InstallationChanged);
            }
            Ok(current)
        })();
        result.map_err(|error| {
            if matches!(error, LaunchErrorCode::PermissionDenied) {
                error
            } else {
                LaunchErrorCode::InstallationChanged
            }
        })
    }
    fn revalidate(&self) -> Result<(), LaunchErrorCode> {
        let current = self.current_file()?;
        verify_publisher(&current, &self.path)
    }
}

fn read_at(file: &Handle, offset: i64, buffer: &mut [u8]) -> Result<(), LaunchErrorCode> {
    // Used only during construction, before the immutable file is shared.
    let mut count = 0;
    if unsafe { SetFilePointerEx(file.0, offset, ptr::null_mut(), FILE_BEGIN) } == 0
        || unsafe {
            ReadFile(
                file.0,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut count,
                ptr::null_mut(),
            )
        } == 0
        || count as usize != buffer.len()
    {
        return Err(LaunchErrorCode::InstallationUntrusted);
    }
    Ok(())
}
fn verify_pe(file: &Handle, size: u64) -> Result<(), LaunchErrorCode> {
    let mut dos = [0u8; 64];
    read_at(file, 0, &mut dos)?;
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap());
    if &dos[..2] != b"MZ" || offset < 64 || u64::from(offset) + 26 > size || offset > 1024 * 1024 {
        return Err(LaunchErrorCode::InstallationUntrusted);
    }
    let mut pe = [0u8; 26];
    read_at(file, i64::from(offset), &mut pe)?;
    let machine = u16::from_le_bytes([pe[4], pe[5]]);
    let characteristics = u16::from_le_bytes([pe[22], pe[23]]);
    let optional_size = u16::from_le_bytes([pe[20], pe[21]]);
    let mut system = SYSTEM_INFO::default();
    unsafe {
        GetNativeSystemInfo(&mut system);
    }
    let expected = match unsafe { system.Anonymous.Anonymous.wProcessorArchitecture } {
        PROCESSOR_ARCHITECTURE_AMD64 => 0x8664,
        PROCESSOR_ARCHITECTURE_ARM64 => 0xaa64,
        _ => return Err(LaunchErrorCode::UnsupportedPlatform),
    };
    if &pe[..4] != b"PE\0\0"
        || machine != expected
        || characteristics & 0x0002 == 0
        || characteristics & 0x2000 != 0
        || optional_size < 112
        || u64::from(offset) + 24 + u64::from(optional_size) > size
        || pe[24..26] != [0x0b, 0x02]
    {
        return Err(LaunchErrorCode::InstallationUntrusted);
    }
    // Official CLI releases have no PE version resources; these are not a trust gate.
    Ok(())
}

fn verify_publisher(file: &Handle, path: &str) -> Result<(), LaunchErrorCode> {
    let path = wide(path);
    let mut info = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: path.as_ptr(),
        hFile: file.0,
        ..Default::default()
    };
    let mut trust = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut info },
        dwStateAction: WTD_STATEACTION_VERIFY,
        // Use the normal Windows Authenticode provider policy, like PowerShell's
        // Get-AuthenticodeSignature. Allow system chain retrieval, not cache-only
        // trust or an application-specific offline revocation requirement. The
        // caller runs this off the UI thread and fences late results by its token.
        // Any nonzero trust status is rejected, with no weaker-policy retry.
        dwProvFlags: 0,
        ..Default::default()
    };
    let mut policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            INVALID_HANDLE_VALUE,
            &mut policy,
            (&mut trust as *mut WINTRUST_DATA).cast(),
        )
    };
    let accepted = status == 0
        && unsafe {
            let provider = WTHelperProvDataFromStateData(trust.hWVTStateData);
            if provider.is_null() {
                false
            } else {
                // Index 0, not a countersigner or an arbitrary certificate from the bag.
                let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
                if signer.is_null()
                    || (*signer).dwError != 0
                    || (*signer).csCertChain == 0
                    || (*signer).pasCertChain.is_null()
                {
                    false
                } else {
                    let leaf = &*(*signer).pasCertChain;
                    leaf.dwError == 0 && !leaf.pCert.is_null() && publisher_subject(&*leaf.pCert)
                }
            }
        };
    trust.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(
            INVALID_HANDLE_VALUE,
            &mut policy,
            (&mut trust as *mut WINTRUST_DATA).cast(),
        );
    }
    if accepted {
        Ok(())
    } else {
        Err(LaunchErrorCode::InstallationUntrusted)
    }
}

unsafe fn publisher_subject(certificate: &CERT_CONTEXT) -> bool {
    if certificate.pCertInfo.is_null() {
        return false;
    }
    let subject = &(*certificate.pCertInfo).Subject;
    let mut decoded: *mut CERT_NAME_INFO = ptr::null_mut();
    let mut size = 0;
    if CryptDecodeObjectEx(
        X509_ASN_ENCODING,
        X509_NAME,
        subject.pbData,
        subject.cbData,
        CRYPT_DECODE_ALLOC_FLAG,
        ptr::null(),
        (&mut decoded as *mut *mut CERT_NAME_INFO).cast(),
        &mut size,
    ) == 0
        || decoded.is_null()
    {
        return false;
    }
    let accepted = (|| {
        if (*decoded).cRDN == 0 || (*decoded).cRDN > 64 || (*decoded).rgRDN.is_null() {
            return false;
        }
        let mut organization = 0;
        for rdn in std::slice::from_raw_parts((*decoded).rgRDN, (*decoded).cRDN as usize) {
            if rdn.cRDNAttr == 0 || rdn.cRDNAttr > 64 || rdn.rgRDNAttr.is_null() {
                return false;
            }
            for attribute in std::slice::from_raw_parts(rdn.rgRDNAttr, rdn.cRDNAttr as usize) {
                if attribute.pszObjId.is_null() {
                    return false;
                }
                let oid = CStr::from_ptr(attribute.pszObjId.cast()).to_bytes();
                if oid != b"2.5.4.10" {
                    continue;
                }
                let mut value = [0u16; 64];
                let len = CertRDNValueToStrW(
                    attribute.dwValueType,
                    &attribute.Value,
                    value.as_mut_ptr(),
                    value.len() as u32,
                ) as usize;
                if len == 0 || len > value.len() || value[..len] != wide("Ollama Inc.") {
                    return false;
                }
                organization += 1;
            }
        }
        organization == 1
    })();
    LocalFree(decoded.cast());
    accepted
}

struct WindowsInstallation {
    source: InstallationSource,
    frozen: Arc<LockedInstallation>,
}
impl InstalledRuntime for WindowsInstallation {
    fn source(&self) -> InstallationSource {
        self.source
    }
    fn spawn(&self, token: &CancellationToken) -> Result<Box<dyn OwnedRuntime>, LaunchErrorCode> {
        if token.is_cancelled() {
            return Err(LaunchErrorCode::Cancelled);
        }
        self.frozen.revalidate()?;
        ensure_no_existing_process(&self.frozen, None)?;
        ensure_port_free()?;
        // Read only the allowlisted values, not the parent application's secrets.
        let mut inherited = Vec::new();
        for key in INHERITED_ENV {
            if let Some(value) = std::env::var_os(key) {
                inherited.push((
                    (*key).to_owned(),
                    value
                        .into_string()
                        .map_err(|_| LaunchErrorCode::InvalidRequest)?,
                ));
            }
        }
        let environment = child_environment(inherited.into_iter())?;
        if token.is_cancelled() {
            return Err(LaunchErrorCode::Cancelled);
        }
        // Keep the executable locked, not its user's entire directory hierarchy.
        inspect_directories(&self.frozen.path)?;
        self.frozen.current_file()?;
        let mut owned = create_owned(Arc::clone(&self.frozen), environment)?;
        let result = (|| {
            self.frozen.current_file()?;
            // Recheck while our child is suspended. A concurrent external start is
            // never adopted, and a subsequent race must still pass listener ownership.
            ensure_no_existing_process(&self.frozen, Some(owned.pid))?;
            ensure_port_free()?;
            if token.is_cancelled() {
                return Err(LaunchErrorCode::Cancelled);
            }
            owned.require_job_membership()?;
            if !same_path(&process_image(&owned.process)?, &self.frozen.path) {
                return Err(LaunchErrorCode::OwnershipUnverified);
            }
            if unsafe { ResumeThread(owned.thread.as_ref().ok_or(LaunchErrorCode::SpawnFailed)?.0) }
                == u32::MAX
            {
                return Err(last_error(LaunchErrorCode::SpawnFailed));
            }
            owned.thread.take();
            if token.is_cancelled() {
                return Err(LaunchErrorCode::Cancelled);
            }
            Ok(())
        })();
        if let Err(error) = result {
            // Return the owned (possibly still suspended) child and original cause.
            // Parent cleanup keeps this handle if the job has not confirmed exit.
            owned.startup_error = Some(error);
        }
        Ok(Box::new(owned))
    }
}

fn ensure_no_existing_process(
    installation: &LockedInstallation,
    owned_pid: Option<u32>,
) -> Result<(), LaunchErrorCode> {
    let snapshot = Handle::new(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) },
        LaunchErrorCode::Failed,
    )?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    let gui_path = format!("{}\\ollama app.exe", installation.directory);
    while found != 0 {
        let len = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .ok_or(LaunchErrorCode::OwnershipUnverified)?;
        let name = String::from_utf16(&entry.szExeFile[..len])
            .map_err(|_| LaunchErrorCode::OwnershipUnverified)?;
        if Some(entry.th32ProcessID) != owned_pid
            && (name.eq_ignore_ascii_case("ollama.exe")
                || name.eq_ignore_ascii_case("ollama app.exe"))
        {
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                    0,
                    entry.th32ProcessID,
                )
            };
            if raw.is_null() {
                // An exited snapshot entry is benign; inaccessible live candidates are not.
                if unsafe { GetLastError() } != ERROR_INVALID_PARAMETER {
                    return Err(last_error(LaunchErrorCode::OwnershipUnverified));
                }
            } else {
                let process = Handle(raw);
                if !process_exited(&process)? {
                    let image = process_image(&process)?;
                    if same_path(&image, &installation.path) || same_path(&image, &gui_path) {
                        return Err(LaunchErrorCode::ExistingProcess);
                    }
                    // Short-name or alternate path aliases must not hide this
                    // installation's CLI or supervisor. No command lines are read.
                    if !normal_local_path(&image) {
                        return Err(LaunchErrorCode::OwnershipUnverified);
                    }
                    let image_file =
                        open_file(&image)?.ok_or(LaunchErrorCode::OwnershipUnverified)?;
                    let resolved = final_path(&image_file)?;
                    let id = identity(&image_file)?;
                    if same_path(&resolved, &installation.path)
                        || same_path(&resolved, &gui_path)
                        || (id.volume == installation.identity.volume
                            && id.index == installation.identity.index)
                    {
                        return Err(LaunchErrorCode::ExistingProcess);
                    }
                }
            }
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
        return Err(last_error(LaunchErrorCode::OwnershipUnverified));
    }
    Ok(())
}
fn process_image(process: &Handle) -> Result<String, LaunchErrorCode> {
    let mut buffer = vec![0u16; MAX_PATH_UNITS];
    let mut len = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
        return Err(last_error(LaunchErrorCode::OwnershipUnverified));
    }
    String::from_utf16(&buffer[..len as usize]).map_err(|_| LaunchErrorCode::OwnershipUnverified)
}
fn process_exited(process: &Handle) -> Result<bool, LaunchErrorCode> {
    match unsafe { WaitForSingleObject(process.0, 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(last_error(LaunchErrorCode::OwnershipUnverified)),
    }
}
fn listeners() -> Result<Vec<MIB_TCPROW_OWNER_PID>, LaunchErrorCode> {
    let mut bytes = 0;
    let status = unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut bytes,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if status != ERROR_INSUFFICIENT_BUFFER && status != ERROR_SUCCESS {
        return Err(LaunchErrorCode::OwnershipUnverified);
    }
    for _ in 0..3 {
        if bytes as usize > MAX_TABLE_BYTES {
            return Err(LaunchErrorCode::OwnershipUnverified);
        }
        let mut buffer = vec![0usize; (bytes as usize).max(4).div_ceil(size_of::<usize>())];
        let capacity = buffer.len() * size_of::<usize>();
        bytes = capacity as u32;
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut bytes,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if status != ERROR_SUCCESS || bytes as usize > capacity || bytes < 4 {
            return Err(LaunchErrorCode::OwnershipUnverified);
        }
        let count = unsafe { *buffer.as_ptr().cast::<u32>() } as usize;
        let offset = std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table);
        if count > (bytes as usize).saturating_sub(offset) / size_of::<MIB_TCPROW_OWNER_PID>() {
            return Err(LaunchErrorCode::OwnershipUnverified);
        }
        let rows = unsafe {
            std::slice::from_raw_parts(
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<MIB_TCPROW_OWNER_PID>(),
                count,
            )
        };
        return Ok(rows
            .iter()
            .filter(|r| {
                u16::from_be(r.dwLocalPort as u16) == PORT
                    && (r.dwLocalAddr == LOOPBACK || r.dwLocalAddr == 0)
            })
            .copied()
            .collect());
    }
    Err(LaunchErrorCode::OwnershipUnverified)
}
fn ensure_port_free() -> Result<(), LaunchErrorCode> {
    if !listeners()?.is_empty() {
        return Err(LaunchErrorCode::PortInUse);
    }
    // HTTP failure is not proof that binding is possible (including IPv6 dual-stack
    // and excluded/reserved ports). This is only a precheck, not an ownership claim.
    TcpListener::bind(("127.0.0.1", PORT)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            LaunchErrorCode::PermissionDenied
        } else {
            LaunchErrorCode::PortInUse
        }
    })?;
    Ok(())
}

// https://github.com/ollama/ollama/blob/main/envconfig/config.go
// Explicit upstream envconfig keys, not OLLAMA_* / GPU_* wildcards. Do not copy
// provider tokens, proxies, debug settings, PATH, DLL injection or remote origins.
const INHERITED_ENV: &[&str] = &[
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMDATA",
    "TEMP",
    "TMP",
    "OLLAMA_MODELS",
    "OLLAMA_KEEP_ALIVE",
    "OLLAMA_LOAD_TIMEOUT",
    "OLLAMA_FLASH_ATTENTION",
    "OLLAMA_KV_CACHE_TYPE",
    "OLLAMA_LLM_LIBRARY",
    "OLLAMA_NUM_PARALLEL",
    "OLLAMA_MAX_LOADED_MODELS",
    "OLLAMA_MAX_QUEUE",
    "OLLAMA_SCHED_SPREAD",
    "OLLAMA_GPU_OVERHEAD",
    "OLLAMA_CONTEXT_LENGTH",
    "OLLAMA_VULKAN",
    "OLLAMA_IGPU_ENABLE",
    "CUDA_VISIBLE_DEVICES",
    "HIP_VISIBLE_DEVICES",
    "ROCR_VISIBLE_DEVICES",
    "GGML_VK_VISIBLE_DEVICES",
    "GPU_DEVICE_ORDINAL",
    "HSA_OVERRIDE_GFX_VERSION",
    "LLAMA_ARG_FIT",
    "LLAMA_ARG_FIT_TARGET",
];
const FIXED_ENV: &[(&str, &str)] = &[
    ("OLLAMA_HOST", "127.0.0.1:11434"),
    ("OLLAMA_NO_CLOUD", "1"),
    ("OLLAMA_NOPRUNE", "1"),
    ("OLLAMA_DEBUG", "0"),
    ("OLLAMA_DEBUG_LOG_REQUESTS", "0"),
    ("OLLAMA_ORIGINS", ""),
    ("OLLAMA_NOHISTORY", "1"),
];
fn child_environment(
    input: impl Iterator<Item = (String, String)>,
) -> Result<Vec<u16>, LaunchErrorCode> {
    let mut selected = BTreeMap::new();
    for (key, value) in input {
        let key = key.to_ascii_uppercase();
        if INHERITED_ENV.contains(&key.as_str()) {
            if value.contains('\0') {
                return Err(LaunchErrorCode::InvalidRequest);
            }
            selected.insert(key, value);
        }
    }
    for (key, value) in FIXED_ENV {
        selected.insert((*key).to_owned(), (*value).to_owned());
    }
    let mut environment = Vec::new();
    for (key, value) in selected {
        environment.extend(wide(&format!("{key}={value}")));
    }
    environment.push(0);
    if environment.len() > 32_767 {
        return Err(LaunchErrorCode::InvalidRequest);
    }
    Ok(environment)
}

struct Attributes<'a> {
    storage: Vec<usize>,
    // UpdateProcThreadAttribute retains lpValue until the list is destroyed.
    _handles: PhantomData<&'a Handle>,
}
impl<'a> Attributes<'a> {
    fn new(job: &'a Handle, null: &'a Handle) -> Result<Self, LaunchErrorCode> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 2, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 1024 * 1024 {
            return Err(LaunchErrorCode::SpawnFailed);
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        if unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
        } == 0
        {
            return Err(last_error(LaunchErrorCode::SpawnFailed));
        }
        let mut result = Self {
            storage,
            _handles: PhantomData,
        };
        for (attribute, value) in [
            (PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.0),
            (PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &null.0),
        ] {
            if unsafe {
                UpdateProcThreadAttribute(
                    result.pointer(),
                    0,
                    attribute as usize,
                    (value as *const HANDLE).cast(),
                    size_of::<HANDLE>(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            } == 0
            {
                return Err(last_error(LaunchErrorCode::SpawnFailed));
            }
        }
        Ok(result)
    }
    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
}
impl Drop for Attributes<'_> {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer());
        }
    }
}
struct WindowsOwned {
    startup_error: Option<LaunchErrorCode>,
    job: Handle,
    process: Handle,
    thread: Option<Handle>,
    pid: u32,
    _installation: Arc<LockedInstallation>,
}
fn create_owned(
    installation: Arc<LockedInstallation>,
    environment: Vec<u16>,
) -> Result<WindowsOwned, LaunchErrorCode> {
    let job = Handle::new(
        unsafe { CreateJobObjectW(ptr::null(), ptr::null()) },
        LaunchErrorCode::SpawnFailed,
    )?;
    let mut limit = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limit as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(last_error(LaunchErrorCode::SpawnFailed));
    }
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let null = Handle::new(
        unsafe {
            CreateFileW(
                wide("NUL").as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &security,
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            )
        },
        LaunchErrorCode::SpawnFailed,
    )?;
    let mut attributes = Attributes::new(&job, &null)?;
    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: size_of::<STARTUPINFOEXW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: null.0,
            hStdOutput: null.0,
            hStdError: null.0,
            ..Default::default()
        },
        lpAttributeList: attributes.pointer(),
    };
    let executable = wide(&installation.path);
    let mut command = wide(&format!("\"{}\" serve", installation.path));
    let directory = wide(&installation.directory);
    let mut information = PROCESS_INFORMATION::default();
    // Kernel job assignment is part of creation, not a post-spawn window. Only NUL
    // is inherited, not this private job, file locks, or application handles.
    if unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            environment.as_ptr().cast(),
            directory.as_ptr(),
            &startup.StartupInfo,
            &mut information,
        )
    } == 0
    {
        return Err(last_error(LaunchErrorCode::SpawnFailed));
    }
    // Delete the retained handle-value pointers before moving their owners.
    drop(attributes);
    Ok(WindowsOwned {
        startup_error: None,
        job,
        process: Handle(information.hProcess),
        thread: Some(Handle(information.hThread)),
        pid: information.dwProcessId,
        _installation: installation,
    })
}
impl WindowsOwned {
    fn require_job_membership(&self) -> Result<(), LaunchErrorCode> {
        let mut member = 0;
        if unsafe { IsProcessInJob(self.process.0, self.job.0, &mut member) } == 0 || member == 0 {
            return Err(LaunchErrorCode::OwnershipUnverified);
        }
        Ok(())
    }
    fn job_empty(&self) -> Result<bool, LaunchErrorCode> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.job.0,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(LaunchErrorCode::StopFailed);
        }
        Ok(info.ActiveProcesses == 0)
    }
}
impl OwnedRuntime for WindowsOwned {
    fn startup_error(&self) -> Option<LaunchErrorCode> {
        self.startup_error
    }
    fn exited(&mut self) -> Result<bool, LaunchErrorCode> {
        process_exited(&self.process)
    }
    fn owns_listener(&self) -> Result<bool, LaunchErrorCode> {
        if process_exited(&self.process)? {
            return Ok(false);
        }
        self.require_job_membership()?;
        let rows = listeners()?;
        Ok(rows.len() == 1
            && rows[0].dwOwningPid == self.pid
            && rows[0].dwLocalAddr == LOOPBACK
            && !process_exited(&self.process)?)
    }
    fn stop(&mut self) -> Result<(), LaunchErrorCode> {
        if process_exited(&self.process)? && self.job_empty()? {
            return Ok(());
        }
        if unsafe { TerminateJobObject(self.job.0, 1) } == 0 {
            return Err(LaunchErrorCode::StopFailed);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if process_exited(&self.process)? && self.job_empty()? {
                self.thread.take();
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(LaunchErrorCode::StopFailed)
    }
}
// Deliberately no blocking Drop: explicit stop confirms exit; final ownership
// release closes the private job first and relies on KILL_ON_JOB_CLOSE as fallback.

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_plain_absolute_installation_paths() {
        for path in [
            r"C:\Users\Alice\AppData\Local\Programs\Ollama\ollama.exe",
            r"D:\本地模型\Ollama\ollama.exe",
        ] {
            assert!(normal_local_path(path));
        }
        for path in [
            r"\\server\Ollama\ollama.exe",
            r"\\?\C:\Ollama\ollama.exe",
            r"C:ollama.exe",
            r"C:\Ollama\..\ollama.exe",
            r"C:\Ollama\ollama.exe:stream",
            r"C:\Ollama.\ollama.exe",
            r"C:\Ollama\\ollama.exe",
            "C:\\Ollama\\ollama.exe\0",
        ] {
            assert!(!normal_local_path(path), "{path}");
        }
    }
    #[test]
    fn environment_preserves_models_and_gpu_but_overrides_exposure() {
        let input = [
            ("Ollama_Models", r"D:\我的模型"),
            ("CUDA_VISIBLE_DEVICES", "1"),
            ("OLLAMA_HOST", "0.0.0.0:9999"),
            ("OLLAMA_ORIGINS", "*"),
            ("OLLAMA_DEBUG", "1"),
            ("OLLAMA_NO_CLOUD", "0"),
            ("OLLAMA_NOPRUNE", "0"),
            ("OPENAI_API_KEY", "secret"),
            ("PATH", "evil"),
            ("HTTPS_PROXY", "proxy"),
        ];
        let actual =
            child_environment(input.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())))
                .unwrap();
        let text = String::from_utf16(&actual).unwrap();
        assert!(text.contains("OLLAMA_MODELS=D:\\我的模型\0"));
        assert!(text.contains("CUDA_VISIBLE_DEVICES=1\0"));
        for (key, value) in FIXED_ENV {
            assert!(text.contains(&format!("{key}={value}\0")));
        }
        for forbidden in [
            "secret",
            "evil",
            "proxy",
            "0.0.0.0",
            "9999",
            "OLLAMA_ORIGINS=*",
        ] {
            assert!(!text.contains(forbidden));
        }
        assert!(text.ends_with("\0\0"));
    }
    #[test]
    fn environment_rejects_embedded_nul_and_oversize_values() {
        assert!(child_environment(
            [(String::from("OLLAMA_MODELS"), String::from("a\0b"))].into_iter()
        )
        .is_err());
        assert!(child_environment(
            [(String::from("OLLAMA_MODELS"), "x".repeat(32_767))].into_iter()
        )
        .is_err());
    }
}
