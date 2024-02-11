
$env.NUPM_HOME = ($env.HOME | path join ".local" "nupm")

# Directories to search for scripts when calling source or use
# The default for this is $nu.default-config-dir/scripts
$env.NU_LIB_DIRS = [
    ($env.NUPM_HOME | path join "modules")
]