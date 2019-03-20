import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './user.entity';
import { Repository } from 'typeorm';
import { CreateUserDto } from './create-user.dto';
import { ConfigService } from '../config/config.service';
import { ServerService } from '../server/server.service';
import { getIdForActor, ActorType } from '../activitypub/definitions/actor.interface';
import { Post } from '../post/post.entity';
import { UserActor } from '../activitypub/definitions/actors/user.actor';
import { AP } from '../activitypub/definitions/constants';
import * as URI from 'uri-js';

@Injectable()
export class UserService {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        private readonly configService: ConfigService,
        private readonly serverService: ServerService
    ) {}

    async create(user: CreateUserDto): Promise<User> {
        const hostname = this.serverService.parseHostname(user.server);
        const server = (await this.serverService.findOrCreate(hostname)) ||
            (await this.serverService.local());
        const userEntity = this.userRepository.create({
            name: user.name,
            server: server,
            displayName: user.displayName,
            summary: user.summary || '',
            icon: user.iconUrl || ''
        });

        userEntity.uri = userEntity.uri || getIdForActor(userEntity, ActorType.User);

        return this.userRepository.save(userEntity);
    }

    async createEmptyUserEntry(username: string): Promise<User> {
        if (await this.findByName(username)) {
            throw new Error(`Username ${username} already in database`);
        }

        const userEntity = this.userRepository.create({
            name: username,
            server: await this.serverService.local(),
            displayName: username,
            summary: '',
            icon: ''
        });

        userEntity.uri = userEntity.uri || getIdForActor(userEntity, ActorType.User);

        return this.userRepository.save(userEntity);
    }

    async delete(name: string): Promise<User> {
        try {
            const user = await this.findByName(name);

            return await this.userRepository.remove(user);
        } catch (e) {
            throw new Error(`User ${name} does not exist`);
        }
    }

    async findAll(): Promise<User[]> {
        return await this.userRepository.find();
    }

    async find(id: number): Promise<User> {
        return this.userRepository.findOneOrFail(id);
    }

    async findByName(name: string): Promise<User> {
        return this.userRepository.findOne({ name: name });
    }

    /**
     * Returns the User entity representing the user with the given name
     * on this server.
     *
     * @param name The name of the user to retrieve
     * @returns A User DB entity
     * @memberof UserService
     */
    async findLocalByName(name: string): Promise<User> {
        try {
            const response = await this.userRepository.findOneOrFail({
                name: name,
                server: await this.serverService.local()
            });

            return response;
        } catch (e) {
            return Promise.reject(new Error(`User ${name} does not exist on this server`));
        }
    }

    async findGlobalByName(name: string, server: string): Promise<User> {
        const serverEntity = await this.serverService.find(this.serverService.parseHostname(server));

        try {
            const response = await this.userRepository.findOneOrFail({
                name,
                server: serverEntity
            });

            return response;
        } catch (e) {
            return Promise.reject(new Error(`Cannot find user ${name}@${server}`));
        }
    }

    async getLikes(user: User): Promise<User> {
        return this.userRepository.findOne(user.id, { relations: ['liked'] });
    }

    async addLike(user: User, post: Post): Promise<User> {
        const result = await this.getLikes(user);

        result.liked.push(post);
        return this.userRepository.save(result);
    }

    /**
     * Creates an ActivityPub Actor object for the given user entity.
     *
     * @param user The database entity representing the user
     * @returns A new Actor object for the user
     * @memberof UserService
     */
    createActor(user: User): UserActor {
        const idAddress = this.idForUser(user);
        return {
            '@context': AP.Context,
            id: idAddress,
            type: 'Person',
            name: user.displayName || user.name,
            preferredUsername: user.name,
            summary: user.summary,
            icon: user.icon,

            inbox: `${idAddress}/${AP.InboxAddress}/`,
            outbox: `${idAddress}/${AP.OutboxAddress}/`,
            followers: `${idAddress}/${AP.FollowersAddress}/`,
            following: `${idAddress}/${AP.FollowingAddress}/`
        }
    }

    idForUser(user: User): string {
        console.log('*** User', user);
        
        if (user.uri) {
            return user.uri;
        } else {
            // Same configuration needs as for groups
            const uri = URI.serialize({
                scheme: user.server.scheme,
                host: user.server.host,
                port: user.server.port,
                path: `/user/${user.name}`
            })

            return uri;
        }
    }
}
