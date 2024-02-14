FROM archlinux
RUN pacman -Sy --noconfirm --needed base-devel nushell git
RUN git clone https://github.com/joaqim/nu-fortnox /opt/nu-fortnox
WORKDIR /opt/nu-fortnox
RUN git pull
RUN git submodule update --init --recursive

WORKDIR /context

# Create a non-root user
RUN useradd build
RUN chown -R build:build /context

USER build
RUN git clone https://aur.archlinux.org/mongosh-bin.git
ENV MAKEFLAGS="-j$(nproc)"
ENV PKGEXT=".pkg.tar"
RUN cd mongosh-bin && makepkg -src

USER root
# Install mongo-sh as root
RUN find /context -name "*.pkg.tar" -exec pacman -U --noconfirm {} \;
RUN userdel -f build


ENV USER_NAME=slackbot

# Add a user with restricted permissions
RUN useradd -m $USER_NAME && \
    chown -R $USER_NAME:$USER_NAME /home/$USER_NAME && \
    chmod -R 700 /home/$USER_NAME

RUN chsh -s /usr/bin/nu $USER_NAME

USER $USER_NAME
RUN git config --global --add safe.directory /opt/nu-fortnox

RUN mkdir -p /home/$USER_NAME/.config/nushell
ADD --chown=$USER_NAME:$USER_NAME ./nushell-config/ /home/$USER_NAME/.config/nushell
RUN touch /home/$USER_NAME/.config/nushell/.env.nu


WORKDIR /home/$USER_NAME


ENV NUPM_HOME=/home/${USER_NAME}/.local/nupm
RUN mkdir -p ${NUPM_HOME}/modules

RUN mkdir ~/pkgs
RUN git clone https://github.com/nushell/nupm ~/pkgs/nupm

#RUN ["use", "~/nupm/nupm/", ";", \
#"nupm", "install", "--force", "--path", "~/nupm/", ";", \
#"nupm", "install", "--force", "--path", "/opt/nu-fortnox"]

ENV NUPM_HOME="/home/$USER_NAME/.local/nupm"
RUN nu -c "use ~/pkgs/nupm/nupm/ ; nupm install --force --path ~/pkgs/nupm"
RUN nu -c "use ${NUPM_HOME}/modules/nupm ; nupm install --force --path /opt/nu-fortnox"

ENV _FORTNOX_USE_CACHE = true
ENV _FORTNOX_DB_CREDENTIALS_QUERY = '{"provider": "fortnox"}'

WORKDIR /home/$USER_NAME
SHELL ["/usr/bin/nu"]